/**
 * KS-4343 / ADR-135 §2.5. Раннер пазла раздела «Точность» на новой
 * схеме `tactic_puzzles` (Maia-difficulty).
 *
 * Развитие `PlayVsEngineRunner` (см. ADR-135 §2.5, исходник сохранён как
 * референс — удаление в T10). Ключевые отличия:
 *   - линия НЕ зафиксирована заранее, длина определяется во время игры;
 *   - сложность каждой следующей позиции считается клиентом через общий
 *     модуль из shared (`analyzePlyForTacticPuzzle`) — те же критерии,
 *     что использовал сервер при генерации стартовой позиции;
 *   - индикатор «сложно/просто» обновляется в реальном времени по мере
 *     роста глубины Stockfish (`go infinite`);
 *   - `stopReason` ∈ `easy | mate | mistake | timeout | aborted`
 *     (см. ADR-135 §2.1 и shared `TacticPuzzleStopReason`).
 *
 * MVP-разрез T6: основной цикл «ход пользователя → проверка → ответ
 * движка → проверка сложности следующей позиции → решение продолжать или
 * предложить кнопки». Расширения (анимированный live-бар, PostGameReview,
 * accuracy-grade на клиенте, мат-форсы) — отдельными задачами на T10
 * после готовности API (KS-4342) и наработки UX.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Chess, type Square } from 'chess.js';
import {
  analyzePlyForTacticPuzzle,
  TACTIC_PUZZLE_GEN_DEFAULTS,
  type TacticPuzzleGenSettings,
  type TacticSfEngine,
  type TacticSfLine,
  type MaiaPolicySource,
  type TacticPuzzleResponse,
  type TacticPuzzleStopReason,
} from '@kingside/shared';
import {
  WasmEngineAdapter,
  type EngineAdapter,
  type AnalysisResult,
  type WdlDistribution,
  type WasmEngineErrorReason,
} from '../../utils/engineAdapter';
import { predictMoves } from '../../lib/maia';
import { PuzzleBoard } from '../PuzzleBoard';
import { WdlChancesBar } from '../WdlChancesBar';
import { EngineLoader } from '../EngineLoader';
import type { EngineErrorReason } from '../../hooks/useStockfish';

// ─── Public API ─────────────────────────────────────────────────────

export interface TacticPuzzleRunnerSubmit {
  solved: boolean;
  /** Длина решённой линии — число полуходов пользователя. */
  lineHalfMoves: number;
  /** Все UCI пользователя через пробел. */
  userMoves: string;
  /** Причина остановки попытки. */
  stopReason: TacticPuzzleStopReason;
  /** Длительность попытки в мс. */
  timeMs: number;
  /** Стартовое expected-score (E = W+D/2) POV решающего. */
  wdlStart: number | null;
  /** Финальное expected-score POV решающего. */
  wdlEnd: number | null;
}

export interface TacticPuzzleRunnerProps {
  puzzle: TacticPuzzleResponse;
  /**
   * Вызывается один раз при завершении попытки. Родитель сам решает,
   * слать ли `tacticPuzzleApi.submitAttempt` (гостям — нет).
   */
  onSubmit?: (data: TacticPuzzleRunnerSubmit) => void | Promise<void>;
  /** Следующий пазл. */
  onNext?: () => void;
  /** Назад в каталог (с сохранением фильтров). */
  onBack?: () => void;
  /**
   * KS-4347. Открыть позицию пазла в мастерской (анализ). Если задан —
   * раннер показывает кнопку «Открыть в мастерской» рядом с доской.
   * Семантика: засчитать попытку как сдачу (`stopReason='aborted'`) и
   * перейти на маршрут мастерской. Отправку attempt и навигацию делает
   * родительская страница; раннер только инициирует завершение через
   * стандартный `finishAttempt` + сигнал.
   */
  onOpenWorkshop?: (data: TacticPuzzleRunnerSubmit) => void | Promise<void>;
  /**
   * DI для тестов — позволяет подменить движок.
   * Production — `() => new WasmEngineAdapter(...)`.
   */
  engineFactory?: () => EngineAdapter;
  /** Источник Maia-policy для проверки сложности. Дефолт — общий `predictMoves`. */
  maiaSource?: MaiaPolicySource;
  /**
   * Глубина / время для analyze (engine-ответ + классификация).
   * Дефолты подобраны симметрично PlayVsEngineRunner (KS-2955).
   */
  analyzeDepth?: number;
  analyzeMovetimeMs?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────

type RunnerState =
  | 'thinking' // ждём ход пользователя
  | 'evaluating' // считаем ответ движка / проверку сложности
  | 'engine' // движок играет
  | 'win'
  | 'lose'
  | 'error';

function sideFromFen(fen: string): 'w' | 'b' {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

function flipWdl(wdl: WdlDistribution): WdlDistribution {
  return { w: wdl.l, d: wdl.d, l: wdl.w };
}

function scoreToWdlSigned(score: { type: 'cp' | 'mate'; value: number }): number {
  if (score.type === 'mate') return score.value > 0 ? 1 : -1;
  const k = 400;
  return 2 / (1 + Math.exp(-score.value / k)) - 1;
}

function expectedScoreFromLine(line: { wdl?: WdlDistribution; score?: { type: 'cp' | 'mate'; value: number } }): number {
  if (line.wdl) {
    return (line.wdl.w + line.wdl.d / 2) / 1000;
  }
  if (line.score) {
    // Стандарт lichess: E = (W + D/2) с сигмоидной свёрткой cp.
    const signed = scoreToWdlSigned(line.score); // [-1..1]
    return (signed + 1) / 2;
  }
  return 0.5;
}

function pickBestLine(result: AnalysisResult): AnalysisResult['lines'][number] | null {
  if (!result.lines.length) return null;
  const sorted = [...result.lines].sort((a, b) => a.multipv - b.multipv);
  return sorted[0];
}

/**
 * Адаптер `EngineAdapter` → `TacticSfEngine` (контракт shared). Превращает
 * наши `InfoLine[]` в `TacticSfLine[]` (move/E/wdl) и поддерживает
 * `go nodes N` для серверно-совместимого режима.
 *
 * Внимание: `EngineAdapter` сериализуется на одном WASM-worker'е через
 * единый ref-queue в раннере; адаптер сам не управляет очередью —
 * вызывающий гарантирует отсутствие конкурентных go-команд.
 */
function makeTacticSfEngine(
  queueAnalyze: (
    fen: string,
    opts: { nodes?: number; multiPv: number },
  ) => Promise<AnalysisResult>,
): TacticSfEngine {
  return {
    analyze: async (fen, multiPV, nodes) => {
      const r = await queueAnalyze(fen, { multiPv: multiPV, nodes });
      const lines: TacticSfLine[] = r.lines
        .slice()
        .sort((a, b) => a.multipv - b.multipv)
        .map((l) => ({
          move: l.pv[0] ?? '',
          E: expectedScoreFromLine(l),
          wdl: l.wdl ?? null,
        }));
      // Максимальная глубина — наибольшее значение из info-строк.
      const maxDepth = r.lines.reduce((m, l) => Math.max(m, l.depth), 0);
      return { lines, maxDepth };
    },
  };
}

/** Источник Maia-policy по умолчанию — общий клиентский `predictMoves`. */
const defaultMaiaSource: MaiaPolicySource = {
  predictMoves: async (fen, eloW, eloB) => {
    const policy = await predictMoves(fen, eloW, eloB);
    return { policy };
  },
};

// ─── Component ──────────────────────────────────────────────────────

const CLASSIFY_DEEP_DEPTH = 24;
const CLASSIFY_DEEP_MOVETIME_MS = 2500;

/** Безопасный таймаут попытки — 10 минут. После — `stopReason='timeout'`. */
const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;

export function TacticPuzzleRunner({
  puzzle,
  onSubmit,
  onNext,
  onBack,
  onOpenWorkshop,
  engineFactory,
  maiaSource = defaultMaiaSource,
  analyzeDepth = 18,
  analyzeMovetimeMs = 1000,
}: TacticPuzzleRunnerProps) {
  const { t } = useTranslation();

  const solverSide = useMemo<'w' | 'b'>(() => sideFromFen(puzzle.fen), [puzzle.fen]);
  const orientation = solverSide === 'w' ? 'white' : 'black';

  // Параметры алгоритма «сложно/просто» — клиентский режим (без main/verify
  // бюджетов, см. ADR-135 §2.3). В клиенте используем те же пороги
  // `difficultyMin`/`gapMin`, что и сервер; разница только в режиме SF.
  const settings = useMemo<TacticPuzzleGenSettings>(
    () => ({
      ...TACTIC_PUZZLE_GEN_DEFAULTS,
      // В клиенте verify-проход не делаем (live-режим), используем главный
      // pass как «единственный»: ставим main=verify=один analyze. Бюджет
      // узлов вместо go infinite задаём через `nodes` в `queueAnalyze`.
      sfMainNodes: 1_000_000,
      sfVerifyNodes: 1_000_000,
    }),
    [],
  );

  // ── Game state ────────────────────────────────────────────────────
  const [game, setGame] = useState<Chess>(() => new Chess(puzzle.fen));
  const [state, setState] = useState<RunnerState>('thinking');
  const [errorMsg, setErrorMsg] = useState('');
  const [lastMoveUci, setLastMoveUci] = useState<string | null>(null);
  /** Текущий «правильный» ход, против которого проверяется ход пользователя.
   * На старте — `puzzle.bestMoveUci`. После — установлен из клиентского
   * `analyzePlyForTacticPuzzle.candidate.bestMoveUci`. */
  const expectedBestUciRef = useRef<string>(puzzle.bestMoveUci);
  /** Можно ли пользователю завершить пазл — `true` когда текущая позиция
   * перестала быть «сложной» по критериям ADR-135 §2.1. */
  const [canFinish, setCanFinish] = useState(false);
  /** Длина решённой линии (число полуходов пользователя). */
  const halfMovesRef = useRef(0);
  const userMovesRef = useRef<string[]>([]);
  const submittedRef = useRef(false);
  const startTimeRef = useRef(Date.now());
  /** Последний live-WDL POV solver — для индикатора. */
  const [latestWdl, setLatestWdl] = useState<WdlDistribution | null>(null);
  /** Стартовый E (W+D/2) POV решающего — отдаётся в attempt.wdlStart. */
  const wdlStartRef = useRef<number | null>(null);

  // ── Engine ────────────────────────────────────────────────────────
  const [engineLoadState, setEngineLoadState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [engineLoadProgress, setEngineLoadProgress] = useState(0);
  const [engineErrorReason, setEngineErrorReason] =
    useState<EngineErrorReason>(null);
  const engineRef = useRef<EngineAdapter | null>(null);
  const engineInitPromiseRef = useRef<Promise<EngineAdapter> | null>(null);
  const engineQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * KS-4345 / KS-3391 pattern. Generation-счётчик «живого» анализа:
   * каждый запуск/остановка инкрементит его, и устаревший `onUpdate`
   * (от прошлой позиции) перестаёт писать в `latestWdl`. `liveInFlightRef`
   * — реально ли сейчас идёт `go infinite` на worker'е: `stop()` шлём
   * только когда это так, чтобы случайно не оборвать классификационный
   * `analyze`.
   */
  const liveGenRef = useRef(0);
  const liveInFlightRef = useRef(false);

  const ensureEngine = useCallback((): Promise<EngineAdapter> => {
    if (engineRef.current) return Promise.resolve(engineRef.current);
    if (engineInitPromiseRef.current) return engineInitPromiseRef.current;
    setEngineLoadState('loading');
    setEngineLoadProgress(0);
    setEngineErrorReason(null);
    const promise = (async () => {
      const engine = engineFactory
        ? engineFactory()
        : new WasmEngineAdapter({
            onProgress: (loaded, total) => {
              if (total > 0) {
                setEngineLoadProgress(Math.min(0.99, loaded / total));
              }
            },
            onError: (reason: WasmEngineErrorReason) => {
              setEngineErrorReason(reason);
              setEngineLoadState('error');
            },
          });
      try {
        await engine.init();
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          setEngineLoadState((prev) => (prev === 'loading' ? 'error' : prev));
        }
        engineInitPromiseRef.current = null;
        throw err;
      }
      engineRef.current = engine;
      setEngineLoadProgress(1);
      setEngineLoadState('ready');
      return engine;
    })();
    engineInitPromiseRef.current = promise;
    return promise;
  }, [engineFactory]);

  const retryEngineInit = useCallback(() => {
    try {
      engineRef.current?.destroy();
    } catch {
      /* ignore */
    }
    engineRef.current = null;
    engineInitPromiseRef.current = null;
    setEngineErrorReason(null);
    setEngineLoadState('idle');
    setEngineLoadProgress(0);
    void ensureEngine().catch(() => undefined);
  }, [ensureEngine]);

  /**
   * Сериализованный analyze: один WASM-worker не выдерживает конкурентных
   * `go`-команд. Промисификация через цепочку `engineQueueRef`.
   */
  const queueAnalyze = useCallback(
    (
      fen: string,
      opts?: {
        multiPv?: number;
        depth?: number;
        movetimeMs?: number;
        nodes?: number;
      },
    ): Promise<AnalysisResult> => {
      const next = engineQueueRef.current.then(async () => {
        const eng = await ensureEngine();
        return eng.analyze(
          fen,
          opts?.depth ?? analyzeDepth,
          opts?.multiPv ?? 1,
          opts?.movetimeMs ?? analyzeMovetimeMs,
          opts?.nodes,
        );
      });
      engineQueueRef.current = next.catch(() => undefined);
      return next;
    },
    [ensureEngine, analyzeDepth, analyzeMovetimeMs],
  );

  /**
   * KS-4345. «Живой» непрерывный анализ позиции игрока. На каждой info-
   * строке Stockfish обновляем `latestWdl` (POV solver) — полоса
   * шансов уточняется в реальном времени по мере роста глубины.
   *
   * Сам по себе НЕ завершается (`go infinite`) — гасится
   * `stopLiveAnalysis()` перед каждым классификационным `queueAnalyze`
   * (иначе один WASM-worker не сможет принять новую `go`-команду).
   */
  const startLiveAnalysis = useCallback(
    (fen: string) => {
      const gen = ++liveGenRef.current;
      const queued = engineQueueRef.current.then(async () => {
        // Отменён до старта (игрок успел сходить / сменился пазл) —
        // выходим без go infinite, очередь сразу свободна для analyze.
        if (gen !== liveGenRef.current) return;
        const eng = await ensureEngine();
        if (gen !== liveGenRef.current) return;
        liveInFlightRef.current = true;
        try {
          await eng.analyzeLive(fen, 1, (info) => {
            if (gen !== liveGenRef.current) return;
            // Side-to-move в `fen` == текущий ходящий. Когда live запущен
            // на позиции, где ходит solver, info.wdl уже POV solver.
            // Когда live запущен на позиции, где ходит соперник
            // (промежуточные кадры между ходом игрока и ответом движка),
            // флипаем под POV solver.
            const stm = sideFromFen(fen);
            const wdlSolver =
              info.wdl == null
                ? null
                : stm === solverSide
                  ? info.wdl
                  : flipWdl(info.wdl);
            if (wdlSolver) setLatestWdl(wdlSolver);
          });
        } finally {
          liveInFlightRef.current = false;
        }
      });
      engineQueueRef.current = queued.catch(() => {
        liveInFlightRef.current = false;
      });
    },
    [ensureEngine, solverSide],
  );

  /**
   * KS-4345. Остановить «живой» анализ. Инкремент `liveGenRef`
   * инвалидирует stale onUpdate и pending-старт; `stop()` дёргаем
   * только когда `go infinite` реально идёт — иначе он мог бы
   * оборвать классификационный analyze.
   */
  const stopLiveAnalysis = useCallback(() => {
    liveGenRef.current++;
    if (liveInFlightRef.current) {
      try {
        engineRef.current?.stop();
      } catch {
        /* ignore */
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      try {
        engineRef.current?.destroy();
      } catch {
        /* ignore */
      }
      engineRef.current = null;
      engineInitPromiseRef.current = null;
    };
  }, []);

  // Безопасный таймаут попытки.
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (submittedRef.current) return;
      void finishAttempt({
        solved: false,
        stopReason: 'timeout',
      });
    }, ATTEMPT_TIMEOUT_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Submit one-shot ───────────────────────────────────────────────
  const finishAttempt = useCallback(
    async (args: { solved: boolean; stopReason: TacticPuzzleStopReason }) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      // KS-4345. Попытка завершена — гасим «живой» анализ, чтобы
      // worker не молотил `go infinite` после показа результата.
      stopLiveAnalysis();
      const wdlEnd = latestWdl
        ? (latestWdl.w + latestWdl.d / 2) / 1000
        : null;
      const data: TacticPuzzleRunnerSubmit = {
        solved: args.solved,
        lineHalfMoves: halfMovesRef.current,
        userMoves: userMovesRef.current.join(' '),
        stopReason: args.stopReason,
        timeMs: Date.now() - startTimeRef.current,
        wdlStart: wdlStartRef.current,
        wdlEnd,
      };
      setState(args.solved ? 'win' : 'lose');
      try {
        await onSubmit?.(data);
      } catch (e) {
        // Не валим UI, если submit не прошёл — пользователь увидит «win»,
        // ошибку отправит наверх в консоль.
        console.warn('TacticPuzzleRunner: submit failed', e);
      }
    },
    [onSubmit, latestWdl, stopLiveAnalysis],
  );

  // ── User move handler ────────────────────────────────────────────
  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) => {
      if (state !== 'thinking' || !targetSquare) return false;
      // chess.js: применяем ход, авто-promotion = ферзь для MVP.
      // Промоушн-picker — отдельным усложнением (KS-2969 pattern, не MVP).
      const probe = new Chess(game.fen());
      let mv;
      try {
        mv = probe.move({
          from: sourceSquare as Square,
          to: targetSquare as Square,
          promotion: 'q',
        });
      } catch {
        return false;
      }
      if (!mv) return false;
      const playedUci = `${mv.from}${mv.to}${mv.promotion ?? ''}`;
      // KS-4345. Игрок сходил — гасим «живой» анализ его прежней
      // позиции и освобождаем worker для классификационного analyze.
      // Без этого `go infinite` держал бы движок и `queueAnalyze` ниже
      // встал бы навсегда.
      stopLiveAnalysis();

      // Сверка с ожидаемым лучшим ходом.
      if (playedUci !== expectedBestUciRef.current) {
        // Ошибка: фиксируем ход в строку, закрываем попытку как mistake.
        userMovesRef.current.push(playedUci);
        halfMovesRef.current += 1;
        setGame(probe);
        setLastMoveUci(playedUci);
        void finishAttempt({ solved: false, stopReason: 'mistake' });
        return true;
      }

      // Правильный ход — фиксируем, играем на доске, запускаем цикл.
      userMovesRef.current.push(playedUci);
      halfMovesRef.current += 1;
      setGame(probe);
      setLastMoveUci(playedUci);
      setCanFinish(false);

      // Мат сразу после хода пользователя.
      if (probe.isCheckmate()) {
        void finishAttempt({ solved: true, stopReason: 'mate' });
        return true;
      }
      if (probe.isStalemate() || probe.isDraw()) {
        void finishAttempt({ solved: true, stopReason: 'mate' });
        return true;
      }

      void runEngineThenAnalyze(probe);
      return true;
    },
    // `runEngineThenAnalyze` объявлен ниже — порядок ссылок не даёт
    // включить его в deps без forward-reference cycle'а. Все остальные
    // используемые значения учтены.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, game, latestWdl, finishAttempt],
  );

  // ── Engine response + difficulty check ────────────────────────────
  const runEngineThenAnalyze = useCallback(
    async (afterUser: Chess) => {
      setState('evaluating');
      // 1) Глубокий analyze на позиции после хода пользователя — даёт
      //    `wdlAfter` для логирования + ответ движка (PV1).
      let result: AnalysisResult;
      try {
        result = await queueAnalyze(afterUser.fen(), {
          depth: CLASSIFY_DEEP_DEPTH,
          movetimeMs: CLASSIFY_DEEP_MOVETIME_MS,
        });
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
      const engineUci = best.pv[0];
      // WDL на FEN'е соперника POV соперника → флипаем в POV solver.
      const wdlSolverAfter = best.wdl ? flipWdl(best.wdl) : null;
      if (wdlSolverAfter) setLatestWdl(wdlSolverAfter);

      // 2) Применяем ход движка.
      if (!engineUci) {
        setErrorMsg('engine-empty-pv');
        setState('error');
        return;
      }
      const afterEngine = new Chess(afterUser.fen());
      try {
        afterEngine.move({
          from: engineUci.slice(0, 2) as Square,
          to: engineUci.slice(2, 4) as Square,
          promotion: engineUci.length > 4 ? engineUci[4] : undefined,
        });
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : 'engine-bad-move');
        setState('error');
        return;
      }
      setGame(afterEngine);
      setLastMoveUci(engineUci);
      setState('engine');

      // 3) Терминал после движка → завершение.
      if (afterEngine.isCheckmate()) {
        void finishAttempt({ solved: true, stopReason: 'mate' });
        return;
      }
      if (afterEngine.isStalemate() || afterEngine.isDraw()) {
        void finishAttempt({ solved: true, stopReason: 'mate' });
        return;
      }

      // 4) Проверка сложности новой позиции через shared.
      const sfEngine: TacticSfEngine = makeTacticSfEngine(queueAnalyze);
      try {
        const verdict = await analyzePlyForTacticPuzzle(
          {
            ply: halfMovesRef.current + 1,
            fen: afterEngine.fen(),
            isGameOver: afterEngine.isGameOver(),
          },
          sfEngine,
          maiaSource,
          settings,
        );
        if (verdict.kind === 'accepted') {
          // Позиция всё ещё сложная — продолжаем. Запоминаем новый
          // ожидаемый ход и возвращаемся в `thinking`.
          expectedBestUciRef.current = verdict.candidate.bestMoveUci;
          if (verdict.candidate.wdl) {
            const wdl = verdict.candidate.wdl;
            setLatestWdl({ w: wdl.w, d: wdl.d, l: wdl.l });
          }
          setCanFinish(false);
          setState('thinking');
        } else {
          // Сложность упала — даём пользователю возможность завершить.
          // `bestMoveUci` фиксируем «лучшим из текущих линий», чтобы
          // «пропустить ход» сыграл его (см. ADR-135 §2.5 п. 7).
          // Если shared не дал кандидата (rejected), пытаемся взять
          // best из последнего analyze.
          const ar = await queueAnalyze(afterEngine.fen(), {
            depth: CLASSIFY_DEEP_DEPTH,
            movetimeMs: 1000,
          });
          const b = pickBestLine(ar);
          if (b && b.pv[0]) {
            expectedBestUciRef.current = b.pv[0];
            if (b.wdl) setLatestWdl(b.wdl);
          }
          setCanFinish(true);
          setState('thinking');
        }
        // KS-4345. На новой позиции игрока запускаем «живой» анализ —
        // полоса шансов уточняется, пока он думает над ответом.
        // `thinking` к этому моменту уже выставлен; запускаем после
        // классификационных queueAnalyze, иначе live перехватит
        // worker до их завершения.
        startLiveAnalysis(afterEngine.fen());
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : 'difficulty-check-failed');
        setState('error');
      }
    },
    [queueAnalyze, maiaSource, settings, finishAttempt, startLiveAnalysis],
  );

  // ── Initial difficulty bar + snapshot стартовой оценки ──────────
  useEffect(() => {
    // Стартовый WDL уже есть в puzzle DTO — берём его, чтобы полосa
    // показывала «сложную» позицию сразу, не дожидаясь анализа.
    if (puzzle.wdl) {
      setLatestWdl(puzzle.wdl);
      // E (W + D/2) — single-number метрика, нужная backend'у в
      // `SubmitTacticAttemptInput.wdlStart`. POV solver.
      wdlStartRef.current =
        (puzzle.wdl.w + puzzle.wdl.d / 2) / 1000;
    }
    // KS-4345. «Живой» непрерывный анализ стартовой FEN — полоса
    // шансов уточняется в реальном времени, пока пользователь думает
    // над первым ходом. Гасится `stopLiveAnalysis()` ниже при первом
    // же ходе или размонтировании.
    startLiveAnalysis(puzzle.fen);
    return () => {
      stopLiveAnalysis();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [puzzle.id]);

  // ── User finish/skip buttons handlers ────────────────────────────
  const handleFinish = useCallback(() => {
    if (!canFinish || state !== 'thinking') return;
    // Сложность упала, пользователь закрывает попытку как решённую:
    // соответствует `easy` (см. ADR-135 §2.1 / shared
    // `TacticPuzzleStopReason`).
    void finishAttempt({ solved: true, stopReason: 'easy' });
  }, [canFinish, state, finishAttempt]);

  const handleSkip = useCallback(() => {
    if (!canFinish || state !== 'thinking') return;
    // «Пропустить ход»: за пользователя играем зафиксированный bestMoveUci
    // и продолжаем цикл — attempt не закрывается. См. ADR-135 §2.5 п. 7.
    const probe = new Chess(game.fen());
    let mv;
    try {
      mv = probe.move({
        from: expectedBestUciRef.current.slice(0, 2) as Square,
        to: expectedBestUciRef.current.slice(2, 4) as Square,
        promotion:
          expectedBestUciRef.current.length > 4
            ? expectedBestUciRef.current[4]
            : 'q',
      });
    } catch {
      return;
    }
    if (!mv) return;
    const playedUci = `${mv.from}${mv.to}${mv.promotion ?? ''}`;
    // KS-4345. «Пропустить ход» тоже ведёт к новому циклу analyze —
    // гасим live, чтобы освободить worker.
    stopLiveAnalysis();
    userMovesRef.current.push(playedUci);
    halfMovesRef.current += 1;
    setGame(probe);
    setLastMoveUci(playedUci);
    setCanFinish(false);
    if (probe.isCheckmate()) {
      void finishAttempt({ solved: true, stopReason: 'mate' });
      return;
    }
    void runEngineThenAnalyze(probe);
  }, [
    canFinish,
    state,
    game,
    runEngineThenAnalyze,
    finishAttempt,
    stopLiveAnalysis,
  ]);

  const handleAbort = useCallback(() => {
    if (submittedRef.current) return;
    void finishAttempt({ solved: false, stopReason: 'aborted' });
  }, [finishAttempt]);

  /**
   * KS-4347. Открыть позицию пазла в мастерской. По смыслу — сдача
   * попытки + переход. Чтобы родительская страница могла одним вызовом
   * и отправить attempt, и сделать `navigate`, собираем те же данные,
   * что `finishAttempt` для `onSubmit`, но передаём в `onOpenWorkshop`.
   * Дальше — сторона страницы решает порядок (submit + redirect).
   */
  const handleOpenWorkshop = useCallback(() => {
    if (submittedRef.current || !onOpenWorkshop) return;
    submittedRef.current = true;
    stopLiveAnalysis();
    const wdlEnd = latestWdl
      ? (latestWdl.w + latestWdl.d / 2) / 1000
      : null;
    const data: TacticPuzzleRunnerSubmit = {
      solved: false,
      lineHalfMoves: halfMovesRef.current,
      userMoves: userMovesRef.current.join(' '),
      stopReason: 'aborted',
      timeMs: Date.now() - startTimeRef.current,
      wdlStart: wdlStartRef.current,
      wdlEnd,
    };
    void onOpenWorkshop(data);
  }, [latestWdl, onOpenWorkshop, stopLiveAnalysis]);

  // ── Render ────────────────────────────────────────────────────────
  if (engineLoadState === 'loading' || engineLoadState === 'error') {
    return (
      <EngineLoader
        variant="block"
        state={engineLoadState}
        loadProgress={engineLoadProgress}
        errorReason={engineErrorReason}
        onRetry={retryEngineInit}
      />
    );
  }

  const isThinking = state === 'thinking';
  const isWin = state === 'win';
  const isLose = state === 'lose';
  const isError = state === 'error';

  return (
    <div
      className="puzzle-engine-runner tactic-puzzle-runner"
      data-testid="tactic-puzzle-runner"
      data-state={state}
      data-puzzle-id={puzzle.id}
    >
      <div className="puzzle-engine-runner__layout">
        <div className="puzzle-engine-runner__board-col">
          {/* KS-4346: полоса оценки W/D/L над доской — тот же компонент
              и место, что и в PlayVsEngineRunner (/precision). До этого
              тикета полоса жила в своей обёртке `.tactic-puzzle-runner__
              wdlbar`, отрисовывалась криво и не совпадала по отступам с
              /precision. Сейчас лежит прямой child'ом board-col, на
              desktop попадает в первый grid-row над доской, на mobile —
              в шапку колонки. */}
          <WdlChancesBar
            wdl={latestWdl}
            testId="tactic-puzzle-wdl-chances"
          />

          <PuzzleBoard
            game={game}
            boardOrientation={orientation}
            enabled={isThinking && !isWin && !isLose}
            onPieceDrop={onPieceDrop}
            lastMoveUci={lastMoveUci}
            boardKey={puzzle.id}
            status={
              isThinking
                ? 'thinking'
                : state === 'evaluating' || state === 'engine'
                  ? 'checking'
                  : isWin
                    ? 'correct'
                    : isLose
                      ? 'incorrect'
                      : null
            }
          />

          {/* KS-4346: кнопки «Пропустить» / «Завершить» — `precision-
              result-actions--compact`-стиль, как Back/Next в /precision
              после win/lose. Выводятся прямо под доской, чтобы
              пользователь не скроллил искать действия. */}
          {isThinking && canFinish && (
            <div
              className="precision-result-actions precision-result-actions--compact tactic-puzzle-runner__finish-controls"
              data-testid="tactic-puzzle-finish-controls"
            >
              <button
                type="button"
                className="play-btn play-btn--secondary play-btn--compact"
                onClick={handleSkip}
                data-testid="tactic-puzzle-skip"
              >
                {t('tacticPuzzle.actions.skip', 'Skip move')}
              </button>
              <button
                type="button"
                className="play-btn play-btn--compact"
                onClick={handleFinish}
                data-testid="tactic-puzzle-finish"
              >
                {t('tacticPuzzle.actions.finish', 'Finish puzzle')}
              </button>
            </div>
          )}

          {/* KS-4346/KS-4347: кнопки во время решения. «Открыть в
              мастерской» — переход в анализ (засчитывает попытку как
              сдачу, перенаправляет на /analysis с FEN пазла). «Сдаться»
              — закрыть попытку без перехода. Стиль `replay-btn` единый
              с /precision; «Сдаться» с danger-окраской — деструктивное
              действие. */}
          {isThinking && state === 'thinking' && (
            <div
              className="puzzle-engine-runner__actions tactic-puzzle-runner__abort-row"
              data-testid="tactic-puzzle-abort-row"
            >
              {onOpenWorkshop && (
                <button
                  type="button"
                  className="puzzle-engine-runner__replay-btn tactic-puzzle-runner__workshop"
                  onClick={handleOpenWorkshop}
                  data-testid="tactic-puzzle-workshop"
                >
                  {t('tacticPuzzle.actions.openWorkshop', 'Open in workshop')}
                </button>
              )}
              <button
                type="button"
                className="puzzle-engine-runner__replay-btn tactic-puzzle-runner__abort"
                onClick={handleAbort}
                data-testid="tactic-puzzle-abort"
              >
                {t('tacticPuzzle.actions.abort', 'Resign')}
              </button>
            </div>
          )}

          {(isWin || isLose) && (
            <div
              className="puzzle-engine-runner__result tactic-puzzle-runner__result"
              data-testid="tactic-puzzle-result"
            >
              <div
                className={`puzzle-engine-runner__result-label puzzle-engine-runner__result-label--${
                  isWin ? 'win' : 'lose'
                } tactic-puzzle-runner__verdict`}
                data-testid="tactic-puzzle-verdict"
              >
                {isWin
                  ? t('tacticPuzzle.result.solved', 'Solved')
                  : t('tacticPuzzle.result.failed', 'Failed')}
              </div>
              <div
                className="puzzle-engine-runner__result-endnote tactic-puzzle-runner__stats"
                data-testid="tactic-puzzle-stats"
              >
                {t('tacticPuzzle.result.lineLength', 'Moves: {{n}}', {
                  n: halfMovesRef.current,
                })}
              </div>
              {(onBack || onNext) && (
                <div
                  className="precision-result-actions precision-result-actions--compact tactic-puzzle-runner__nav"
                  data-testid="tactic-puzzle-nav"
                >
                  {onBack && (
                    <button
                      type="button"
                      className="play-btn play-btn--secondary play-btn--compact"
                      onClick={onBack}
                      data-testid="tactic-puzzle-back"
                    >
                      {t('common.back', 'Back')}
                    </button>
                  )}
                  {onNext && (
                    <button
                      type="button"
                      className="play-btn play-btn--compact"
                      onClick={onNext}
                      data-testid="tactic-puzzle-next"
                    >
                      {t('common.next', 'Next')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {isError && (
            <div
              className="puzzle-engine-runner__error tactic-puzzle-runner__error"
              data-testid="tactic-puzzle-error"
            >
              {errorMsg || t('tacticPuzzle.error.generic', 'Engine error')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
