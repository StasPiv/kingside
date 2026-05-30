/**
 * KS-3472 (ADR-090 V4 F2). Монолитный поток сборки репертуара из
 * мастер-партий 2400+ по позиции.
 *
 * Алгоритм:
 *   1. Подкачка партий через `GET /opening-trainer/archive-position/games`
 *      (KS-3469, ADR-090 §4.2) батчами по 10 пока `validGames.length < 20`
 *      и `hasMore`.
 *   2. Для каждой партии — GET `archive-service/games/:id` за PGN.
 *   3. Извлекаем «линию» от target-FEN до конца партии, не более
 *      `MAX_LINE_PLIES` полуходов (=20 ходов с каждой стороны).
 *   4. Stockfish-валидация ТОЛЬКО ходов тренируемой стороны
 *      (`plyMover === trainedColor`, где `trainedColor =
 *      invert(targetFen.activeColor)` — мы тренируем сторону, которая
 *      НЕ ходит сразу в target-позиции, потому что в архивной партии
 *      target-позиция — это позиция перед нашим ходом-кандидатом).
 *      На каждом таком полуходе считаем `loss_cp = max(0, eBefore +
 *      eAfter)` (eBefore POV тренируемой, eAfter POV соперника — после
 *      инверсии знака даёт потерю в cp). Если loss_cp > 50 → обрезаем
 *      линию ДО этого полухода. Ходы соперника принимаем без оценки.
 *   5. Партия идёт в `validGames` если после обрезки осталась ≥ 1 ход
 *      тренируемой стороны (иначе bedрик «pathological» — пропуск).
 *   6. По достижении 20 партий или истощения cursor — POST
 *      `/opening-trainer/repertoires` со всеми `validGames.pgn` как
 *      multi-source (ADR-078). После создания navigate
 *      `/opening-trainer/:id`.
 *   7. 0 валидных → `phase='empty'` (caller покажет toast).
 *   8. Отмена через `cancel()` — обрывает loop, останавливает Stockfish,
 *      worker уничтожается.
 *
 * F4 (KS-3470) добавил `useStockfish.movetime`, но здесь работаем
 * напрямую с `WasmEngineAdapter.analyze(fen, depth, multiPv,
 * movetimeMs)` — Promise-based API проще для последовательного
 * перебора, и не плодит лишних React-render циклов на каждое eval.
 * Команда UCI та же — `go movetime N`.
 */
import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import type { TrainerColor } from '@kingside/shared';

import { openingTrainerApi } from '../../api/openingTrainerApi';
import { archiveApi } from '../../api/archive';
import { WasmEngineAdapter, type EngineAdapter } from '../../utils/engineAdapter';

const BATCH_LIMIT = 10;
const TARGET_VALID_GAMES = 20;
const MAX_LINE_PLIES = 40;
const LOSS_THRESHOLD_CP = 50;
/** Глубина-потолок для analyze; реально SF остановится по movetime. */
const ANALYZE_DEPTH_CAP = 40;
const MULTI_PV = 1;

export type RepertoireFromArchivePhase =
  | 'idle'
  | 'fetching'
  | 'analyzing'
  | 'creating'
  | 'done'
  | 'empty'
  | 'error'
  | 'cancelled';

export interface RepertoireFromArchiveState {
  phase: RepertoireFromArchivePhase;
  /** Сколько архивных партий проверено (до фильтра). */
  checked: number;
  /** Сколько прошло фильтр (валидных). */
  valid: number;
  /** Сообщение об ошибке для phase='error'. */
  errorMessage?: string;
}

export interface StartArchiveRepertoireParams {
  /** FEN текущей позиции в AnalysisPage. */
  fen: string;
  /** Сторона тренировки. */
  side: TrainerColor;
  /** Лимит времени Stockfish на каждое eval, мс. */
  movetime: number;
  /** Заголовок репертуара (UI-формирует caller). */
  title: string;
}

const INITIAL_STATE: RepertoireFromArchiveState = {
  phase: 'idle',
  checked: 0,
  valid: 0,
};

/** Извлечь cp-оценку из последней `lines[0]` (multipv=1). mate → ±10000. */
function pickCp(linesByMpv: Map<number, { score: { type: 'cp' | 'mate'; value: number } }>): number | null {
  const top = linesByMpv.get(1);
  if (!top) return null;
  if (top.score.type === 'mate') {
    return top.score.value >= 0 ? 10000 : -10000;
  }
  return top.score.value;
}

/**
 * Прогнать партию через Stockfish, обрезать на первом ходе тренируемой
 * стороны с loss_cp > LOSS_THRESHOLD_CP. Возвращает обрезанный PGN
 * (включая header'ы + ходы до обрезки) или null если в линии нет ни
 * одного валидного хода тренируемой стороны.
 *
 * `reachedAtPly` — 0-based ply, на котором партия достигла target-FEN.
 * После этого ply ходит `trainedColor`. Линию берём от ply=0 до конца
 * partii (для целостной PGN), но СТЭП ОБРЕЗКИ ищем начиная с
 * `reachedAtPly` (раньше — pre-history без оценки).
 */
async function analyzeAndTruncate(opts: {
  engine: EngineAdapter;
  pgn: string;
  reachedAtPly: number;
  trainedColor: 'w' | 'b';
  movetimeMs: number;
  cancelled: () => boolean;
  onPlyProgress?: (plyIndex: number) => void;
}): Promise<string | null> {
  const { engine, pgn, reachedAtPly, trainedColor, movetimeMs, cancelled, onPlyProgress } = opts;

  // Парсим PGN — chess.js даёт verbose history с before/after FEN.
  let game: Chess;
  try {
    game = new Chess();
    game.loadPgn(pgn);
  } catch {
    return null;
  }
  const history = game.history({ verbose: true });
  if (history.length === 0 || reachedAtPly < 0 || reachedAtPly > history.length) {
    return null;
  }

  // Анализируем полуходы от reachedAtPly до min(end, reachedAtPly+MAX_LINE_PLIES).
  const endPly = Math.min(history.length, reachedAtPly + MAX_LINE_PLIES);
  let validTrainedMovesAfter = 0;
  let truncateAtPly = endPly; // exclusive upper bound в обрезанной линии
  for (let i = reachedAtPly; i < endPly; i++) {
    if (cancelled()) return null;
    const m = history[i];
    onPlyProgress?.(i);

    if (m.color !== trainedColor) {
      // Ход соперника — без оценки, идёт в линию.
      continue;
    }

    // Полуход тренируемой стороны: eval(fenBefore) и eval(fenAfter).
    let eBefore: number | null = null;
    let eAfter: number | null = null;
    try {
      const before = await engine.analyze(
        m.before,
        ANALYZE_DEPTH_CAP,
        MULTI_PV,
        movetimeMs,
      );
      const beforeMap = new Map(before.lines.map((l) => [l.multipv, l]));
      eBefore = pickCp(beforeMap);
      if (cancelled()) return null;
      const after = await engine.analyze(
        m.after,
        ANALYZE_DEPTH_CAP,
        MULTI_PV,
        movetimeMs,
      );
      const afterMap = new Map(after.lines.map((l) => [l.multipv, l]));
      eAfter = pickCp(afterMap);
    } catch {
      // Если eval упал — прерываем линию (консервативно: лучше потерять
      // несколько ходов, чем оставить blunder).
      truncateAtPly = i;
      break;
    }

    if (eBefore === null || eAfter === null) {
      truncateAtPly = i;
      break;
    }

    // eBefore — POV тренируемой (она ходит).
    // eAfter — POV соперника (он ходит после хода тренируемой); чтобы
    // привести к POV тренируемой, инвертируем знак → `-eAfter`. Потеря
    // тренируемой = eBefore - (-eAfter) = eBefore + eAfter (положительная часть).
    const lossCp = Math.max(0, eBefore + eAfter);
    if (lossCp > LOSS_THRESHOLD_CP) {
      truncateAtPly = i; // не включаем сам блёндер
      break;
    }
    validTrainedMovesAfter += 1;
  }

  if (validTrainedMovesAfter === 0) {
    // Pathological: первый же ход нашей стороны — блёндер или вообще
    // нет ходов тренируемой стороны до конца партии.
    return null;
  }

  // Соберём PGN из ходов [0..truncateAtPly).
  const truncatedGame = new Chess();
  for (let i = 0; i < truncateAtPly; i++) {
    truncatedGame.move(history[i].san);
  }
  // chess.js .pgn() добавит header'ы исходной партии (loadPgn их сохранил).
  // KS-3458: достаём headers из исходного game для truncatedGame.
  for (const [k, v] of Object.entries(game.header())) {
    if (typeof v === 'string') truncatedGame.header(k, v);
  }
  return truncatedGame.pgn();
}

/** Сторона тренировки → буква chess.js. */
function trainerColorToChessjs(side: TrainerColor): 'w' | 'b' {
  return side === 'white' ? 'w' : 'b';
}

export function useRepertoireFromArchive() {
  const navigate = useNavigate();
  const [state, setState] = useState<RepertoireFromArchiveState>(INITIAL_STATE);
  const engineRef = useRef<EngineAdapter | null>(null);
  const cancelledRef = useRef(false);
  const runningRef = useRef(false);

  const reset = useCallback(() => {
    cancelledRef.current = true;
    if (engineRef.current) {
      try {
        engineRef.current.destroy();
      } catch {
        /* ignore */
      }
      engineRef.current = null;
    }
    runningRef.current = false;
    setState(INITIAL_STATE);
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    if (engineRef.current) {
      try {
        engineRef.current.stop();
      } catch {
        /* ignore */
      }
    }
    setState((s) => ({ ...s, phase: 'cancelled' }));
  }, []);

  const start = useCallback(
    async (params: StartArchiveRepertoireParams) => {
      if (runningRef.current) return;
      runningRef.current = true;
      cancelledRef.current = false;
      setState({ phase: 'fetching', checked: 0, valid: 0 });

      try {
        // Engine init (lazy — экземпляр reusable пока hook жив).
        if (!engineRef.current) {
          engineRef.current = new WasmEngineAdapter();
          await engineRef.current.init();
        }

        const trainedColor = trainerColorToChessjs(params.side);
        const validPgns: Array<{ pgn: string; name: string }> = [];
        let cursor: string | null | undefined = undefined;
        let hasMore = true;
        let checked = 0;

        while (
          hasMore &&
          validPgns.length < TARGET_VALID_GAMES &&
          !cancelledRef.current
        ) {
          setState((s) => ({ ...s, phase: 'fetching' }));
          const page = await openingTrainerApi.archivePositionGames({
            fen: params.fen,
            limit: BATCH_LIMIT,
            ...(cursor != null ? { cursor } : {}),
          });
          hasMore = page.hasMore;
          cursor = page.nextCursor;
          if (page.items.length === 0) break;

          for (const item of page.items) {
            if (cancelledRef.current) break;
            if (validPgns.length >= TARGET_VALID_GAMES) break;
            checked += 1;
            setState((s) => ({ ...s, phase: 'analyzing', checked }));

            try {
              const detail = await archiveApi.getArchiveGameById(item.id);
              if (cancelledRef.current) break;
              const truncatedPgn = await analyzeAndTruncate({
                engine: engineRef.current!,
                pgn: detail.pgn,
                reachedAtPly: item.reachedAtPly,
                trainedColor,
                movetimeMs: params.movetime,
              cancelled: () => cancelledRef.current,
              });
              if (truncatedPgn) {
                const eventName =
                  detail.event ?? detail.white?.name ?? `Game ${checked}`;
                validPgns.push({
                  pgn: truncatedPgn,
                  name:
                    eventName.length > 60
                      ? `${eventName.slice(0, 57)}…`
                      : eventName,
                });
                setState((s) => ({ ...s, valid: validPgns.length }));
              }
            } catch {
              // Игнорируем одну сломанную партию — продолжаем.
              continue;
            }
          }
        }

        if (cancelledRef.current) {
          setState({ phase: 'cancelled', checked, valid: validPgns.length });
          return;
        }

        if (validPgns.length === 0) {
          setState({ phase: 'empty', checked, valid: 0 });
          return;
        }

        setState((s) => ({ ...s, phase: 'creating' }));

        const res = await openingTrainerApi.createRepertoire({
          title: params.title,
          side: params.side,
          sources: validPgns.map((g) => ({ pgn: g.pgn, name: g.name })),
        });

        setState({ phase: 'done', checked, valid: validPgns.length });
        navigate(`/opening-trainer/${res.repertoire.id}`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[useRepertoireFromArchive] failed:', e);
        setState((s) => ({
          ...s,
          phase: 'error',
          errorMessage: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        runningRef.current = false;
      }
    },
    [navigate],
  );

  return { state, start, cancel, reset };
}
