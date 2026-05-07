import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type {
  PuzzleDto,
  PlayVsEnginePuzzleReason,
} from '@kingside/shared';
import { PuzzleBoard } from '../PuzzleBoard';
import { EvalBar } from '../EvalBar';
import { PostGameReview } from './PostGameReview';
import { useSounds, soundEventFromSan } from '../../hooks/useSounds';
import {
  WasmEngineAdapter,
  type EngineAdapter,
  type AnalysisResult,
} from '../../utils/engineAdapter';
import type { EvalLine } from '../../hooks/useStockfish';

/**
 * KS-2466 / ADR-044 §5. Раннер пазла-«удержания преимущества» против
 * локального WASM Stockfish. Реализован как отдельный компонент, чтобы
 * не пересекаться с forced-line веткой `PuzzlePage` (см. KS-2466 §1).
 *
 * Жизненный цикл (ADR §5.2):
 *   thinking  → пользователь делает ход
 *   evaluating→ analyze: посчитать WDL_user, проверить mate / engine-resign
 *   engine    → применить bestmove, halfMovesPlayed++; break при N полуходов
 *   win/lose  → submit attempt, показать итог
 *   error     → сетевая/движковая ошибка
 *
 * Anti-cheat MVP не делаем — вся логика на клиенте (см. ADR §5.4 / задача
 * §5).
 */

export type PlayVsEngineSubmit = {
  solved: boolean;
  halfMovesPlayed: number;
  finalWdl: number;
  reason: PlayVsEnginePuzzleReason;
  timeMs: number;
};

export interface PlayVsEngineRunnerProps {
  puzzle: PuzzleDto;
  /**
   * Вызывается один раз при достижении win/lose. Родитель сам решает,
   * слать ли `puzzleApi.submitAttempt` (для гостей — нет).
   */
  onSubmit?: (data: PlayVsEngineSubmit) => void | Promise<void>;
  /** Кнопка «Следующий пазл» — навигация решается родителем. */
  onNext?: () => void;
  /**
   * DI для тестов — позволяет подменить движок на mock без WASM.
   * Production — `() => new WasmEngineAdapter()`.
   */
  engineFactory?: () => EngineAdapter;
  /** Глубина для анализа. По умолчанию 12 — компромисс скорость/точность. */
  analyzeDepth?: number;
}

type RunnerState = 'thinking' | 'evaluating' | 'engine' | 'win' | 'lose' | 'error';

/**
 * KS-2473: лучший ход юзера на полуходе. PV1 от движка В ПОЗИЦИИ ДО
 * user-хода (т.е. там, где ходит юзер). KS-2509: единственный лог,
 * нужный для post-mortem (PostGameReview); старый `BestmoveSnapshot`
 * (engine-ответы) упразднён вместе с inline-bestmoveHint.
 */
export type UserBestSnapshot = {
  halfMove: number;
  /** FEN, в котором ходил юзер (до его хода). */
  fenBefore: string;
  /** UCI, который юзер сыграл. */
  playedUci: string;
  /** UCI, который рекомендовал движок в той же позиции. */
  bestUci: string;
  /**
   * KS-2505 / ADR-047 §3 #2. cp-оценка позиции `fenBefore` POV юзера
   * (на этом FEN ходит юзер → score из движка уже POV side-to-move).
   * Mate-оценки кодируются ±100000 (см. `cpFromScore`). null —
   * pre-analyze не успел/упал, классификатор downstream должен
   * грейсфолить (KS-2506+).
   */
  cpBefore: number | null;
  /**
   * KS-2506 / ADR-047 §3 #3. cp-оценка позиции ПОСЛЕ хода юзера POV
   * юзера. На post-analyze FEN ходит соперник → score движка POV
   * соперника, поэтому ИНВЕРТИРУЕМ знак: `cpAfter_user = -cpAfter_opp`.
   * Записывается в `runEngineCycle` после первого analyze. null —
   * post-analyze упал / завершился до записи (race с pre-analyze
   * исключён: post-analyze всегда позже создания snapshot'а в
   * pre-analyze, и оба идут через тот же queueAnalyze).
   */
  cpAfter: number | null;
};

/**
 * Сигмоидное преобразование cp → WDL_signed в диапазоне [-1..+1] (ADR §5.2).
 * k=400 — стандарт Lichess; mate → ±1.
 */
function scoreToWdlSigned(score: { type: 'cp' | 'mate'; value: number }): number {
  if (score.type === 'mate') return score.value > 0 ? 1 : -1;
  const k = 400;
  return 2 / (1 + Math.exp(-score.value / k)) - 1;
}

/**
 * KS-2505 / ADR-047 §3 #2. Нормализуем `score` к одному cp-числу для
 * downstream-классификатора (`classifyMove`, KS-2504). Mate кодируется
 * `±MATE_CP_ENCODING` — гигантский cp-loss попадает в blunder, что и
 * нужно для хода, в котором юзер потерял мат.
 *
 * NB: знак не инвертируется — вызывающий обязан передавать `score` в
 * системе отсчёта, в которой он хочет получить cp (POV side-to-move
 * на анализируемом FEN).
 */
const MATE_CP_ENCODING = 100000;
export function cpFromScore(score: { type: 'cp' | 'mate'; value: number }): number {
  if (score.type === 'mate') {
    return score.value > 0 ? MATE_CP_ENCODING : -MATE_CP_ENCODING;
  }
  return score.value;
}

function sideFromFen(fen: string): 'w' | 'b' {
  const parts = fen.split(' ');
  return parts[1] === 'b' ? 'b' : 'w';
}

function pickBestLine(result: AnalysisResult) {
  if (!result.lines.length) return null;
  const sorted = [...result.lines].sort((a, b) => a.multipv - b.multipv);
  return sorted[0];
}

/** Вытащить `EvalLine[]` для `<EvalBar />` из `AnalysisResult`. */
function toEvalLines(result: AnalysisResult): EvalLine[] {
  return result.lines.map((l) => ({
    depth: l.depth,
    multipv: l.multipv,
    score: l.score,
    pv: l.pv.join(' '),
  }));
}

/**
 * KS-2471: UCI→SAN относительно заданного FEN. Если ход не легален или
 * FEN кривой — возвращает исходный UCI как fallback (не падает).
 */
export function uciToSan(uci: string, fen: string): string {
  if (!uci || uci.length < 4) return uci;
  try {
    const c = new Chess(fen);
    const move = c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return move?.san ?? uci;
  } catch {
    return uci;
  }
}

/**
 * KS-2471: SAN зевка соперника. `puzzle.fen` — это позиция ПОСЛЕ зевка
 * (там ходит решатель), поэтому напрямую `chess.move(blunderUci)` не
 * легален. Восстанавливаем before-blunder FEN: переносим фигуру с `to`
 * обратно на `from` и переключаем side-to-move. На capture-зевках
 * взятая фигура восстановиться не может — для SAN это не критично
 * (получим Rf4 вместо Rxf4). При любых ошибках — fallback на UCI.
 */
export function blunderUciToSan(blunderUci: string, postBlunderFen: string): string {
  if (!blunderUci || blunderUci.length < 4) return blunderUci;
  try {
    const c = new Chess(postBlunderFen);
    const from = blunderUci.slice(0, 2) as Parameters<typeof c.get>[0];
    const to = blunderUci.slice(2, 4) as Parameters<typeof c.get>[0];
    const piece = c.get(to);
    if (!piece) return blunderUci;
    // Снимаем фигуру с `to`, ставим на `from`.
    c.remove(to);
    c.put(piece, from);
    // Переключаем side-to-move через переписывание FEN (chess.js не даёт
    // прямого setter'а; парсим и собираем обратно).
    const parts = c.fen().split(' ');
    parts[1] = parts[1] === 'w' ? 'b' : 'w';
    const beforeFen = parts.join(' ');
    const before = new Chess(beforeFen);
    const move = before.move({
      from: blunderUci.slice(0, 2),
      to: blunderUci.slice(2, 4),
      promotion: blunderUci.length > 4 ? blunderUci[4] : undefined,
    });
    return move?.san ?? blunderUci;
  } catch {
    return blunderUci;
  }
}

export function PlayVsEngineRunner({
  puzzle,
  onSubmit,
  onNext,
  engineFactory,
  analyzeDepth = 12,
}: PlayVsEngineRunnerProps) {
  const { t } = useTranslation();
  const { playSound } = useSounds();

  // playVsEngine-параметры с дефолтами по ADR §5.5.
  const params = useMemo(() => {
    const pv = puzzle.playVsEngine;
    return {
      blunderMove: pv?.blunderMove ?? '',
      wdlAfterBlunder: pv?.wdlAfterBlunder ?? 0,
      winThreshold: pv?.winThreshold ?? 0.5,
      failThreshold: pv?.failThreshold ?? 0.0,
      halfMovesN: pv?.halfMovesN ?? 6,
    };
  }, [puzzle]);

  // Сторона решателя — ходит первым после blunder.
  const userSide = useMemo<'w' | 'b'>(() => sideFromFen(puzzle.fen), [puzzle.fen]);
  const orientation = userSide === 'w' ? 'white' : 'black';

  const [game, setGame] = useState<Chess>(() => new Chess(puzzle.fen));
  // KS-2486 reopen: список SAN-нотаций всех применённых ходов (user +
  // engine), накапливаем отдельно — `game` пересоздаётся через
  // `new Chess(game.fen())` на каждом ходу и теряет history, поэтому
  // `game.pgn()` для Workshop-ссылки даёт только последнюю позицию.
  // Сохранение SAN'ов отдельно даёт «настоящую» партию: `?pgn=` в
  // ссылке — это `playedSans.join(' ')`.
  const [playedSans, setPlayedSans] = useState<string[]>([]);
  const [state, setState] = useState<RunnerState>('thinking');
  const [halfMovesPlayed, setHalfMovesPlayed] = useState(0);
  const [evalLines, setEvalLines] = useState<EvalLine[]>([]);
  /**
   * KS-2519: side-to-move на FEN, по которому посчитан текущий
   * `evalLines`. Stockfish отдаёт score POV side-to-move; EvalBar
   * (через `evalToPercent` / `formatEval`) умеет инвертировать знак,
   * если `isBlackTurn=true`. Без этого на FEN'ах, где ходят чёрные
   * (post-analyze, или userSide='b'), bar отображал перевёрнутую
   * оценку. Сохраняется синхронно с `setEvalLines` во всех трёх
   * analyze-местах: initial, post-analyze, final.
   */
  const [evalSide, setEvalSide] = useState<'w' | 'b'>(() =>
    sideFromFen(puzzle.fen),
  );
  const [latestWdlUser, setLatestWdlUser] = useState<number>(params.wdlAfterBlunder);
  const [reason, setReason] = useState<PlayVsEnginePuzzleReason | null>(null);
  /**
   * KS-2473: лог «лучшего хода юзера» в позиции ДО user-move. Заполняется
   * pre-analyze'ом параллельно с engine-ответом, см. `onPieceDrop`.
   */
  const [userBestLog, setUserBestLog] = useState<UserBestSnapshot[]>([]);
  /**
   * KS-2510 / ADR-047 §3 #7. Когда юзер кликает строку в PostGameReview,
   * на доске показываем `fenBefore` выбранного хода. Доска по-прежнему
   * disabled (state ∈ win|lose), фигуры не двигаются. Сбрасывается на
   * null при смене puzzle (через reset useEffect).
   */
  const [reviewFen, setReviewFen] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');

  const startTimeRef = useRef(Date.now());
  const submittedRef = useRef(false);
  const engineRef = useRef<EngineAdapter | null>(null);
  /**
   * KS-2473: атомарный promise инициализации движка. Гарантирует, что
   * параллельные `ensureEngine()` (pre + post analyze в onPieceDrop)
   * получают ОДИН и тот же worker. Без этого создавались два WASM-
   * экземпляра, второй ломал stdin первого, runner падал в `error`.
   */
  const engineInitPromiseRef = useRef<Promise<EngineAdapter> | null>(null);
  /**
   * KS-2473: единый WASM-worker не выдерживает конкурентных analyze
   * (mid-stream разруха stdin → state=error). Сериализуем все вызовы
   * через promise-цепочку.
   */
  const engineQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const lastMoveUciRef = useRef<string | null>(null);

  // ── Engine init / cleanup ─────────────────────────────────────────────
  const ensureEngine = useCallback((): Promise<EngineAdapter> => {
    if (engineRef.current) return Promise.resolve(engineRef.current);
    if (engineInitPromiseRef.current) return engineInitPromiseRef.current;
    const promise = (async () => {
      const engine = engineFactory ? engineFactory() : new WasmEngineAdapter();
      await engine.init();
      engineRef.current = engine;
      return engine;
    })();
    engineInitPromiseRef.current = promise;
    return promise;
  }, [engineFactory]);

  /**
   * KS-2473: сериализованный вызов analyze. Ставит запрос в очередь и
   * возвращает Promise<AnalysisResult>. Гарантирует, что в каждый
   * момент только один analyze в работе.
   */
  const queueAnalyze = useCallback(
    (fen: string): Promise<AnalysisResult> => {
      const next = engineQueueRef.current.then(async () => {
        const eng = await ensureEngine();
        return eng.analyze(fen, analyzeDepth, 1);
      });
      // Не пробрасываем ошибки в цепочку, чтобы один сбой не убил все
      // последующие analyze.
      engineQueueRef.current = next.catch(() => undefined);
      return next;
    },
    [ensureEngine, analyzeDepth],
  );

  useEffect(() => {
    return () => {
      try { engineRef.current?.destroy(); } catch { /* ignore */ }
      engineRef.current = null;
      engineInitPromiseRef.current = null;
    };
  }, []);

  // ── submit attempt one-shot ──────────────────────────────────────────
  const submitOnce = useCallback(
    (solved: boolean, finishReason: PlayVsEnginePuzzleReason, finalWdl: number, finalHalf: number) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      const data: PlayVsEngineSubmit = {
        solved,
        halfMovesPlayed: finalHalf,
        finalWdl,
        reason: finishReason,
        timeMs: Date.now() - startTimeRef.current,
      };
      void onSubmit?.(data);
    },
    [onSubmit],
  );

  // ── Win / lose helpers ───────────────────────────────────────────────
  const finishWin = useCallback(
    (finishReason: 'win' | 'win-mate' | 'win-engine-resign', wdl: number, half: number) => {
      setState('win');
      setReason(finishReason);
      playSound('puzzle-correct');
      submitOnce(true, finishReason, wdl, half);
    },
    [playSound, submitOnce],
  );

  const finishLose = useCallback(
    (finishReason: 'lose-wdl' | 'lose-mate', wdl: number, half: number) => {
      setState('lose');
      setReason(finishReason);
      playSound('puzzle-incorrect');
      submitOnce(false, finishReason, wdl, half);
    },
    [playSound, submitOnce],
  );

  // ── Engine response cycle ────────────────────────────────────────────
  // Запускается после хода игрока: analyze → возможно engine-ответ.
  const runEngineCycle = useCallback(
    async (after: Chess, halfAfterUser: number) => {
      setState('evaluating');
      try {
        await ensureEngine();
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : 'engine-init-failed');
        setState('error');
        return;
      }

      // 1) Оценка после хода пользователя — в этом fen ходит соперник.
      let result: AnalysisResult;
      try {
        result = await queueAnalyze(after.fen());
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : 'engine-error');
        setState('error');
        return;
      }
      const best = pickBestLine(result);
      if (!best) {
        setErrorMsg('engine-no-bestmove');
        setState('error');
        return;
      }
      setEvalLines(toEvalLines(result));
      // KS-2519: side-to-move на FEN после user-хода — соперник.
      setEvalSide(sideFromFen(after.fen()));
      const wdlEngine = scoreToWdlSigned(best.score);
      const wdlUser = -wdlEngine;
      setLatestWdlUser(wdlUser);

      // KS-2506: cpAfter POV юзера = −cp(score) POV соперника. Дописываем
      // в snapshot, созданный pre-analyze'ом. Pre-analyze идёт через
      // тот же queueAnalyze раньше post-analyze, так что snapshot обычно
      // уже на месте; если по какой-то причине pre-analyze упал и
      // snapshot отсутствует — просто молча пропускаем (cpAfter останется
      // вне лога; downstream-классификатор грейсфолит на null).
      const cpAfterUser = -cpFromScore(best.score);
      setUserBestLog((prev) =>
        prev.map((s) =>
          s.halfMove === halfAfterUser ? { ...s, cpAfter: cpAfterUser } : s,
        ),
      );

      // 2) Терминальные ситуации до хода движка.
      if (after.isCheckmate()) {
        // Side-to-move (engine) получил мат от пользователя.
        finishWin('win-mate', 1, halfAfterUser);
        return;
      }
      if (wdlUser < params.failThreshold) {
        finishLose('lose-wdl', wdlUser, halfAfterUser);
        return;
      }
      // engine видит мат против себя — resign.
      if (best.score.type === 'mate' && best.score.value < 0) {
        finishWin('win-engine-resign', wdlUser, halfAfterUser);
        return;
      }

      // 3) Применяем engine bestmove.
      setState('engine');
      const next = new Chess(after.fen());
      const uci = best.pv[0];
      let applied: ReturnType<Chess['move']> | null = null;
      try {
        applied = next.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci.length > 4 ? uci[4] : undefined,
        });
      } catch {
        applied = null;
      }
      if (!applied) {
        setErrorMsg('engine-illegal-move');
        setState('error');
        return;
      }
      playSound(soundEventFromSan(applied.san));
      lastMoveUciRef.current = uci;
      setGame(next);
      // KS-2486 reopen: ход движка тоже идёт в общий лог SAN.
      setPlayedSans((prev) => [...prev, applied!.san]);
      const halfAfterEngine = halfAfterUser + 1;
      setHalfMovesPlayed(halfAfterEngine);

      // 4) Проверки после хода движка.
      if (next.isCheckmate()) {
        // Защитный кейс: §2.3 фильтр должен исключать engine→mate user,
        // но защищаемся.
        finishLose('lose-mate', -1, halfAfterEngine);
        return;
      }
      if (halfAfterEngine >= params.halfMovesN) {
        // Финальный analyze, чтобы сверить wdl_user после хода engine.
        try {
          const final = await queueAnalyze(next.fen());
          const finalBest = pickBestLine(final);
          setEvalLines(toEvalLines(final));
          // KS-2519: после хода движка side-to-move = userSide.
          setEvalSide(sideFromFen(next.fen()));
          // Теперь side-to-move == userSide → POV-знак WDL = +1 для user.
          const wdlFinalUser = finalBest ? scoreToWdlSigned(finalBest.score) : wdlUser;
          setLatestWdlUser(wdlFinalUser);
          if (wdlFinalUser >= params.winThreshold) {
            finishWin('win', wdlFinalUser, halfAfterEngine);
          } else {
            finishLose('lose-wdl', wdlFinalUser, halfAfterEngine);
          }
        } catch {
          // Если final analyze упал — судим по последнему wdlUser.
          if (wdlUser >= params.winThreshold) finishWin('win', wdlUser, halfAfterEngine);
          else finishLose('lose-wdl', wdlUser, halfAfterEngine);
        }
        return;
      }

      // 5) Возвращаем ход пользователю.
      setState('thinking');
    },
    [
      ensureEngine,
      queueAnalyze,
      params.failThreshold,
      params.winThreshold,
      params.halfMovesN,
      finishLose,
      finishWin,
      playSound,
    ],
  );

  // ── User move handler ────────────────────────────────────────────────
  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!targetSquare) return false;
      if (state !== 'thinking') return false;

      const next = new Chess(game.fen());
      let move: ReturnType<Chess['move']> | null = null;
      try {
        // Авто-продвижение в ферзя для MVP — ADR §5.6.
        move = next.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });
      } catch {
        move = null;
      }
      if (!move) return false;
      playSound(soundEventFromSan(move.san));
      const playedUci = sourceSquare + targetSquare;
      lastMoveUciRef.current = playedUci;
      const fenBefore = game.fen();
      setGame(next);
      // KS-2486 reopen: пишем SAN в общий лог, чтобы потом собрать
      // PGN партии для Workshop-ссылки.
      setPlayedSans((prev) => [...prev, move!.san]);
      const halfAfterUser = halfMovesPlayed + 1;
      setHalfMovesPlayed(halfAfterUser);

      // KS-2473: pre-analyze позиции ДО хода юзера (PV1 = лучший ход
      // юзера на этом полуходе). У нас один WASM-worker — конкурентные
      // analyze пересекают stdin Stockfish'а и ломают его. Поэтому
      // делаем pre-analyze СЕРИАЛЬНО до post-analyze в runEngineCycle.
      // Запускается фоном (void async) — onPieceDrop остаётся sync,
      // PuzzleBoard сразу анимирует фигуру.
      void (async () => {
        try {
          await ensureEngine();
          const pre = await queueAnalyze(fenBefore);
          const preBest = pickBestLine(pre);
          if (preBest && preBest.pv[0]) {
            // KS-2505: на `fenBefore` ходит юзер → score POV user без
            // инверсии. Mate нормализован cpFromScore до ±100000.
            const cpBefore = cpFromScore(preBest.score);
            setUserBestLog((prev) => [
              ...prev,
              {
                halfMove: halfAfterUser,
                fenBefore,
                playedUci,
                bestUci: preBest.pv[0],
                cpBefore,
                // KS-2506: cpAfter дописывается из runEngineCycle после
                // post-analyze; до этого момента — null.
                cpAfter: null,
              },
            ]);
          }
        } catch {
          /* ignore — post-mortem-подсказка для этого хода будет пустой */
        }
      })();

      if (halfAfterUser >= params.halfMovesN) {
        // По описанию ADR halfMovesN считается общим числом полуходов;
        // если пользователь сделал последний полуход — сразу финальный
        // чек после оценки. evaluating сделает analyze, и далее идёт
        // обычная проверка mate/wdl. Если wdl >= winThreshold и не lose
        // → это уже win, иначе lose.
        // Реализация: запускаем стандартный engine-cycle, но в нём при
        // halfAfterEngine >= N мы делаем final analyze. Чтобы учесть
        // случай user-last-move, обработаем здесь же.
        void (async () => {
          setState('evaluating');
          try {
            await ensureEngine();
            const result = await queueAnalyze(next.fen());
            const best = pickBestLine(result);
            setEvalLines(toEvalLines(result));
            // KS-2519: side-to-move на FEN после user-хода — соперник.
            setEvalSide(sideFromFen(next.fen()));
            if (next.isCheckmate()) {
              finishWin('win-mate', 1, halfAfterUser);
              return;
            }
            const wdlUser = best ? -scoreToWdlSigned(best.score) : 0;
            setLatestWdlUser(wdlUser);
            if (wdlUser < params.failThreshold) {
              finishLose('lose-wdl', wdlUser, halfAfterUser);
              return;
            }
            if (best && best.score.type === 'mate' && best.score.value < 0) {
              finishWin('win-engine-resign', wdlUser, halfAfterUser);
              return;
            }
            if (wdlUser >= params.winThreshold) finishWin('win', wdlUser, halfAfterUser);
            else finishLose('lose-wdl', wdlUser, halfAfterUser);
          } catch (e) {
            setErrorMsg(e instanceof Error ? e.message : 'engine-error');
            setState('error');
          }
        })();
        return true;
      }

      void runEngineCycle(next, halfAfterUser);
      return true;
    },
    [
      state,
      game,
      halfMovesPlayed,
      params.halfMovesN,
      params.failThreshold,
      params.winThreshold,
      runEngineCycle,
      playSound,
      ensureEngine,
      queueAnalyze,
      finishLose,
      finishWin,
    ],
  );

  // ── Reset при смене puzzle ───────────────────────────────────────────
  useEffect(() => {
    setGame(new Chess(puzzle.fen));
    setState('thinking');
    setHalfMovesPlayed(0);
    setEvalLines([]);
    // KS-2519: на старте side-to-move = ходящему в puzzle.fen
    // (решатель). EvalBar до initial analyze получит пустой массив и
    // отрендерит «0.0», но evalSide важен на случай, если первый
    // setEvalLines (initial) опередит сброс.
    setEvalSide(sideFromFen(puzzle.fen));
    setLatestWdlUser(params.wdlAfterBlunder);
    setReason(null);
    setUserBestLog([]);
    // KS-2510: при новом пазле выкл review-snapshot, чтобы доска
    // показывала актуальную позицию для нового решения.
    setReviewFen(null);
    // KS-2486 reopen: сброс SAN-лога при смене drill'а.
    setPlayedSans([]);
    setErrorMsg('');
    submittedRef.current = false;
    startTimeRef.current = Date.now();
    lastMoveUciRef.current = null;
  }, [puzzle.id, puzzle.fen, params.wdlAfterBlunder]);

  // ── KS-2507 / ADR-047 §2.1 + §3 #4 ───────────────────────────────────
  // Initial pre-analyze стартовой позиции — чтобы `<EvalBar />` сразу
  // показывал оценку, а не дефолтный «0.0», пока юзер думает над первым
  // ходом. Идёт через тот же queueAnalyze — последовательно с pre/post
  // analyze, без риска пересечения stdin Stockfish'а.
  //
  // Запускается только при смене puzzle.id (deps по тикету). Race с
  // pre-analyze первого хода: setEvalLines в обоих местах — последний
  // запиcавший выигрывает, что для UI приемлемо: pre-analyze хода
  // запускается на FEN ДО хода (== puzzle.fen на 1-м полуходе), так что
  // оба analyze дают одну и ту же оценку. Ошибки молча проглатываем —
  // EvalBar не критичен.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ensureEngine();
        const initial = await queueAnalyze(puzzle.fen);
        if (cancelled) return;
        setEvalLines(toEvalLines(initial));
        // KS-2519: initial analyze был на puzzle.fen → side = решатель.
        setEvalSide(sideFromFen(puzzle.fen));
      } catch {
        /* ignore — EvalBar не критичен, юзер сделает ход и анализ
           перезапустится в runEngineCycle. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [puzzle.id, puzzle.fen, ensureEngine, queueAnalyze]);

  // ── KS-2508 / ADR-047 §4(i) ──────────────────────────────────────────
  // Fallback-analyze для записей userBestLog без cpAfter. Сценарий:
  // pre-analyze (фоновый, fire-and-forget) опаздывает создать snapshot,
  // и когда runEngineCycle пытается дописать cpAfter через `prev.map`,
  // записи ещё нет — cpAfter теряется. Pre-analyze добавляет snapshot
  // позже с cpAfter=null. После завершения партии (state in win|lose)
  // пробегаем по записям с cpAfter===null и считаем cp на FEN после
  // playedUci через тот же queueAnalyze. Score POV соперника →
  // инвертируем, как в KS-2506.
  useEffect(() => {
    if (state !== 'win' && state !== 'lose') return;
    let cancelled = false;
    void (async () => {
      const missing = userBestLog.filter((s) => s.cpAfter === null);
      if (missing.length === 0) return;
      try {
        await ensureEngine();
      } catch {
        return;
      }
      for (const s of missing) {
        if (cancelled) return;
        try {
          const c = new Chess(s.fenBefore);
          c.move({
            from: s.playedUci.slice(0, 2),
            to: s.playedUci.slice(2, 4),
            promotion:
              s.playedUci.length > 4 ? s.playedUci[4] : undefined,
          });
          const r = await queueAnalyze(c.fen());
          if (cancelled) return;
          const b = pickBestLine(r);
          if (!b) continue;
          const cpAfter = -cpFromScore(b.score);
          setUserBestLog((prev) =>
            prev.map((x) =>
              x.halfMove === s.halfMove ? { ...x, cpAfter } : x,
            ),
          );
        } catch {
          /* ignore — отсутствие cpAfter PostGameReview грейсфолит. */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, userBestLog, ensureEngine, queueAnalyze]);

  // ── UI helpers ───────────────────────────────────────────────────────
  const halfMovesLeft = Math.max(0, params.halfMovesN - halfMovesPlayed);
  const progressPercent = Math.min(100, Math.round((halfMovesPlayed / params.halfMovesN) * 100));
  const isBlackOriented = orientation === 'black';

  // Подсветка blunderMove на стартовой позиции (KS-2466 §4).
  const blunderHighlight = useMemo(() => {
    if (halfMovesPlayed > 0) return null;
    const m = params.blunderMove;
    if (!m || m.length < 4) return null;
    return m;
  }, [halfMovesPlayed, params.blunderMove]);

  // Маппинг внутреннего state → status, который понимает PuzzleBoard.
  const boardStatus = useMemo(() => {
    if (state === 'win') return 'correct';
    if (state === 'lose') return 'incorrect';
    if (state === 'evaluating' || state === 'engine') return 'checking';
    return 'thinking';
  }, [state]);

  const reasonLabel = (r: PlayVsEnginePuzzleReason | null): string => {
    switch (r) {
      case 'win':
        return t('puzzle.engine.win', 'You held the advantage');
      case 'win-mate':
        return t('puzzle.engine.winMate', 'Checkmate!');
      case 'win-engine-resign':
        return t('puzzle.engine.winResign', 'Engine resigned (sees mate)');
      case 'lose-wdl':
        return t('puzzle.engine.loseWdl', 'You lost the advantage');
      case 'lose-mate':
        return t('puzzle.engine.loseMate', 'You got mated');
      default:
        return '';
    }
  };

  // KS-2509 / ADR-047 §3 #6: блок `bestmoveHint` (показывал только
  // последний ход) полностью заменён на `<PostGameReview>` — там
  // полный список ходов с cp-loss классификацией. JSX рендерится
  // ниже в win/lose-блоке.

  // KS-2471: blunder в SAN.
  const blunderSan = useMemo(
    () => blunderUciToSan(params.blunderMove, puzzle.fen),
    [params.blunderMove, puzzle.fen],
  );

  return (
    <div
      className="puzzle-engine-runner"
      data-testid="puzzle-engine-runner"
      data-mode="play-vs-engine"
      data-state={state}
      data-half-moves={halfMovesPlayed}
      data-reason={reason ?? ''}
      data-eval-lines={evalLines.length}
      data-eval-side={evalSide}
      data-review-fen={reviewFen ?? ''}
    >
      <div className="puzzle-engine-runner__layout">
        {/* KS-2519: isBlackTurn должен отражать side-to-move на FEN, по
            которому посчитан evalLines (Stockfish отдаёт score POV
            side-to-move). До тикета сюда подставлялась `isBlackOriented`
            (ориентация доски, не side-to-move) — bar показывал
            перевёрнутую оценку при чёрном решателе. */}
        <EvalBar lines={evalLines} isBlackTurn={evalSide === 'b'} />

        <div className="puzzle-engine-runner__board-col">
          <div className="puzzle-engine-runner__progress" data-testid="puzzle-engine-progress">
            <div className="puzzle-engine-runner__progress-bar">
              <div
                className="puzzle-engine-runner__progress-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="puzzle-engine-runner__progress-label">
              {t('puzzle.engine.halfMovesLeft', '{{count}} half-moves left', {
                count: halfMovesLeft,
              })}
            </div>
          </div>

          {state === 'thinking' && halfMovesPlayed === 0 && (
            <p
              className="puzzle-engine-runner__hint"
              data-testid="puzzle-engine-blunder-hint"
            >
              {t('puzzle.engine.blunderHint', 'Opponent just blundered ({{move}}). Hold the advantage for {{n}} half-moves.', {
                move: blunderSan || '?',
                n: params.halfMovesN,
              })}
            </p>
          )}

          {/* KS-2510: при выбранном snapshot'е (reviewFen != null) на
              доске показываем позицию ДО ошибочного хода, чтобы юзер
              визуально видел альтернативу. Новый Chess создаём ad-hoc;
              он не сохраняется в game-стейт, чтобы ход «Next» вернул
              финальную позицию (не нужна — пазл уже завершён, но
              consistency со стандартным reset-флоу). lastMoveUci при
              review убираем — выделение на старой позиции запутает. */}
          <PuzzleBoard
            game={reviewFen ? new Chess(reviewFen) : game}
            boardOrientation={orientation}
            enabled={state === 'thinking' && !reviewFen}
            onPieceDrop={onPieceDrop}
            lastMoveUci={
              reviewFen ? null : (lastMoveUciRef.current ?? blunderHighlight)
            }
            status={boardStatus}
          />

          {/* KS-2486: открыть пазл в мастерской (анализ). Передаём
              `?fen=<initialPuzzleFen>&pgn=<пройденные ходы>` — Workshop
              откроется с НАЧАЛЬНОЙ позицией пазла и партией всех
              сделанных ходов (включая ходы движка), пользователь
              сможет промотать с начала и разобрать каждый ход
              (KS-2486 reopen). `target=_blank` — не прерывать пазл. */}
          <div
            className="puzzle-engine-runner__actions"
            data-testid="puzzle-engine-actions"
          >
            <a
              className="puzzle-engine-runner__workshop-link"
              data-testid="puzzle-engine-workshop-link"
              href={(() => {
                // KS-2486 reopen: PGN — пройденные ходы (user + engine)
                // в SAN, объединённые пробелом. AnalysisPage парсит
                // SAN из `?pgn=` и реплеит на `?fen=` (initial puzzle FEN).
                const movesText = playedSans.join(' ');
                const fenParam = `fen=${encodeURIComponent(puzzle.fen)}`;
                const pgnParam = movesText
                  ? `&pgn=${encodeURIComponent(movesText)}`
                  : '';
                return `/analysis?${fenParam}${pgnParam}`;
              })()}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('puzzle.engine.openInWorkshop', 'Open in Workshop')}
            </a>
          </div>

          {(state === 'win' || state === 'lose') && (
            <div className="puzzle-engine-runner__result" data-testid="puzzle-engine-result">
              <div className={`puzzle-engine-runner__result-label puzzle-engine-runner__result-label--${state}`}>
                {reasonLabel(reason)}
              </div>
              {/* KS-2518: блок WDL-summary. До тикета был только
                  «Финальный WDL: -0.27», без контекста. Теперь видны
                  стартовый WDL (после blunder'а соперника), финальный и
                  дельта. Mini-header переключается на «Advantage
                  preserved», если delta ≤ 0 (юзер не потерял оценку). */}
              {(() => {
                const startWdl = params.wdlAfterBlunder;
                const finalWdl = latestWdlUser;
                const delta = startWdl - finalWdl; // > 0 = потеряно
                const preserved = delta <= 0;
                const fmtSigned = (n: number): string => {
                  if (Math.abs(n) < 0.005) return '0.00';
                  // U+2212 minus, как в ранее уже принятом форматировании
                  // EvalBar (KS-2466 §UI). Полагаемся на toFixed(2).
                  return `${n > 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`;
                };
                const fmtAbs = (n: number): string =>
                  Math.abs(n).toFixed(2);
                return (
                  <div
                    className={`puzzle-engine-runner__wdl-summary puzzle-engine-runner__wdl-summary--${preserved ? 'preserved' : 'lost'}`}
                    data-testid="puzzle-engine-wdl-summary"
                    data-preserved={preserved ? 'true' : 'false'}
                    data-start-wdl={startWdl.toFixed(2)}
                    data-final-wdl={finalWdl.toFixed(2)}
                    data-delta-wdl={delta.toFixed(2)}
                  >
                    <div className="puzzle-engine-runner__wdl-summary-header">
                      {preserved
                        ? t(
                            'puzzle.engine.summary.preservedHeader',
                            'Advantage preserved',
                          )
                        : t(
                            'puzzle.engine.summary.lostHeader',
                            'Advantage lost',
                          )}
                    </div>
                    <div
                      className="puzzle-engine-runner__wdl-summary-line"
                      data-testid="puzzle-engine-wdl-summary-line"
                    >
                      {preserved
                        ? t(
                            'puzzle.engine.summary.linePreserved',
                            'Starting WDL: {{start}} → Final: {{final}}.',
                            {
                              start: fmtSigned(startWdl),
                              final: fmtSigned(finalWdl),
                            },
                          )
                        : t(
                            'puzzle.engine.summary.lineLost',
                            'Starting WDL: {{start}} → Final: {{final}}. Lost: {{delta}}',
                            {
                              start: fmtSigned(startWdl),
                              final: fmtSigned(finalWdl),
                              delta: fmtAbs(delta),
                            },
                          )}
                    </div>
                  </div>
                );
              })()}
              {/* KS-2508 / ADR-047 §2.2 + §3 #5: список ходов с
                  метками классификации (best/good/inaccuracy/mistake/
                  blunder). Появляется только на win/lose. Если у
                  последнего хода cpAfter=null — fallback-effect выше
                  допишет, и компонент перерисуется с правильной меткой.
                  KS-2510: клик по строке показывает на доске позицию
                  ДО этого хода (`fenBefore`) — для визуального разбора
                  «что было перед моей ошибкой». */}
              <PostGameReview
                userBestLog={userBestLog}
                onSelectMove={(s) => setReviewFen(s.fenBefore)}
              />
              {onNext && (
                <button
                  type="button"
                  className="play-btn"
                  onClick={onNext}
                  data-testid="puzzle-engine-next"
                >
                  {t('puzzle.next', 'Next')}
                </button>
              )}
            </div>
          )}

          {state === 'error' && (
            <div className="puzzle-engine-runner__error" data-testid="puzzle-engine-error">
              {t('puzzle.engine.error', 'Engine error')}: {errorMsg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
