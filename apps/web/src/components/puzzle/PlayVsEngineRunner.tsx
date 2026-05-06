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

type BestmoveSnapshot = {
  /** Полуход, на котором сделан анализ (1..N). */
  halfMove: number;
  /** Чей ход был при этом анализе (FEN side-to-move). */
  sideToMove: 'w' | 'b';
  bestUci: string;
  /**
   * KS-2471: FEN, на котором движок считал bestmove. Нужен для UCI→SAN
   * конвертации в post-mortem. Сохраняется именно тот fen, к которому
   * применим UCI напрямую (т.е. до хода).
   */
  fen: string;
  /** WDL_signed POV side-to-move (то, что вернул движок). */
  wdlPov: number;
};

/**
 * KS-2473: лучший ход юзера на полуходе. PV1 от движка В ПОЗИЦИИ ДО
 * user-хода (т.е. там, где ходит юзер). В отличие от `BestmoveSnapshot`,
 * который содержит «лучший ответ движка после хода юзера», эта
 * структура — для post-mortem-подсказки «ты сыграл X, лучше было Y».
 */
type UserBestSnapshot = {
  halfMove: number;
  /** FEN, в котором ходил юзер (до его хода). */
  fenBefore: string;
  /** UCI, который юзер сыграл. */
  playedUci: string;
  /** UCI, который рекомендовал движок в той же позиции. */
  bestUci: string;
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
  const [state, setState] = useState<RunnerState>('thinking');
  const [halfMovesPlayed, setHalfMovesPlayed] = useState(0);
  const [evalLines, setEvalLines] = useState<EvalLine[]>([]);
  const [latestWdlUser, setLatestWdlUser] = useState<number>(params.wdlAfterBlunder);
  const [reason, setReason] = useState<PlayVsEnginePuzzleReason | null>(null);
  /**
   * Все engine bestmove'ы по полуходам — для post-mortem-подсказки
   * («лучший ход на ходу X был …»). KS-2466 §4.
   */
  const [bestmoveLog, setBestmoveLog] = useState<BestmoveSnapshot[]>([]);
  /**
   * KS-2473: лог «лучшего хода юзера» в позиции ДО user-move. Заполняется
   * pre-analyze'ом параллельно с engine-ответом, см. `onPieceDrop`.
   */
  const [userBestLog, setUserBestLog] = useState<UserBestSnapshot[]>([]);
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
      const sideAfterUser = sideFromFen(after.fen()); // != userSide
      const wdlEngine = scoreToWdlSigned(best.score);
      const wdlUser = -wdlEngine;
      setLatestWdlUser(wdlUser);
      setBestmoveLog((prev) => [
        ...prev,
        {
          halfMove: halfAfterUser,
          sideToMove: sideAfterUser,
          bestUci: best.pv[0],
          fen: after.fen(),
          wdlPov: wdlEngine,
        },
      ]);

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
            setUserBestLog((prev) => [
              ...prev,
              { halfMove: halfAfterUser, fenBefore, playedUci, bestUci: preBest.pv[0] },
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
    setLatestWdlUser(params.wdlAfterBlunder);
    setReason(null);
    setBestmoveLog([]);
    setUserBestLog([]);
    setErrorMsg('');
    submittedRef.current = false;
    startTimeRef.current = Date.now();
    lastMoveUciRef.current = null;
  }, [puzzle.id, puzzle.fen, params.wdlAfterBlunder]);

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

  // KS-2473 / KS-2471: post-mortem-подсказка показывает «ты сыграл X,
  // лучше было Y», где Y — PV1 в позиции ДО хода юзера (`userBestLog`,
  // KS-2473), а не «лучший ответ движка после хода юзера» (старое
  // поведение из bestmoveLog). Если pre-analyze ещё не пришёл (фон
  // не успел до win/lose) — fallback на bestmoveLog (engine-reply),
  // чтобы пользователь хоть что-то увидел.
  const bestmoveHint = useMemo(() => {
    if (state !== 'win' && state !== 'lose') return null;
    const lastUser = userBestLog[userBestLog.length - 1];
    if (lastUser) {
      const playedSan = uciToSan(lastUser.playedUci, lastUser.fenBefore);
      const bestSan = uciToSan(lastUser.bestUci, lastUser.fenBefore);
      return {
        halfMove: lastUser.halfMove,
        playedSan,
        bestSan,
        // True если юзер сыграл оптимально (played == best или одинаковый SAN).
        played: lastUser.playedUci,
        best: lastUser.bestUci,
        kind: 'user' as const,
      };
    }
    if (!bestmoveLog.length) return null;
    const last = bestmoveLog[bestmoveLog.length - 1];
    return {
      halfMove: last.halfMove,
      playedSan: '',
      bestSan: uciToSan(last.bestUci, last.fen),
      played: '',
      best: last.bestUci,
      kind: 'engine' as const,
    };
  }, [state, userBestLog, bestmoveLog]);

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
    >
      <div className="puzzle-engine-runner__layout">
        <EvalBar lines={evalLines} isBlackTurn={isBlackOriented} />

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

          <PuzzleBoard
            game={game}
            boardOrientation={orientation}
            enabled={state === 'thinking'}
            onPieceDrop={onPieceDrop}
            lastMoveUci={lastMoveUciRef.current ?? blunderHighlight}
            status={boardStatus}
          />

          {(state === 'win' || state === 'lose') && (
            <div className="puzzle-engine-runner__result" data-testid="puzzle-engine-result">
              <div className={`puzzle-engine-runner__result-label puzzle-engine-runner__result-label--${state}`}>
                {reasonLabel(reason)}
              </div>
              {bestmoveHint && (
                <div
                  className="puzzle-engine-runner__bestmove-hint"
                  data-testid="puzzle-engine-bestmove-hint"
                  data-kind={bestmoveHint.kind}
                >
                  {bestmoveHint.kind === 'user'
                    ? bestmoveHint.played === bestmoveHint.best
                      ? t('puzzle.engine.bestmoveAt', 'Best move at half-move {{n}}: {{san}}', {
                          n: bestmoveHint.halfMove,
                          san: bestmoveHint.bestSan,
                        })
                      : t(
                          'puzzle.engine.bestmoveDiff',
                          'You played {{played}} on half-move {{n}}, the best move was {{best}}',
                          {
                            n: bestmoveHint.halfMove,
                            played: bestmoveHint.playedSan,
                            best: bestmoveHint.bestSan,
                          },
                        )
                    : t('puzzle.engine.bestmoveAt', 'Best move at half-move {{n}}: {{san}}', {
                        n: bestmoveHint.halfMove,
                        san: bestmoveHint.bestSan,
                      })}
                </div>
              )}
              <div className="puzzle-engine-runner__final-wdl">
                {t('puzzle.engine.finalWdl', 'Final WDL')}: {latestWdlUser.toFixed(2)}
              </div>
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
