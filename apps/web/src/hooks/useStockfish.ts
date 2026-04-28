import { useState, useEffect, useRef, useCallback } from 'react';

export type EvalLine = {
  depth: number;
  multipv: number;
  score: { type: 'cp' | 'mate'; value: number };
  pv: string;
  nodes?: number;
  nps?: number;
};

type StockfishState = 'idle' | 'loading' | 'ready' | 'analyzing' | 'error';

type UseStockfishOptions = {
  depth?: number;
  multiPv?: number;
  autoStart?: boolean;
  /**
   * UCI Skill Level (0..20). Ограничивает силу движка. Применяется к
   * worker'у через `setoption name Skill Level value <N>` сразу после
   * `uciok` (до первого `go`). Используется в уроках-тренажёрах (L-24,
   * KS-1800) — в остальном analysis-коде опцию можно не трогать.
   */
  skillLevel?: number;
  /**
   * KS-1842 (ADR-026 §2.9): префетч движка при монтировании. Если
   * `true` — хук сразу вызывает `init()`, не дожидаясь первого
   * `evaluate`. Это запускает загрузку worker-файла и инициализацию
   * WASM, чтобы к моменту, когда пользователь доходит до шага с
   * движком (напр. `endgame_drill`), engine был уже `ready`.
   *
   * По умолчанию `false` — все существующие потребители (`AnalysisPage`,
   * `BroadcastGamePage`, `WatchGamePage`, `EndgameDrillStep`,
   * `OpeningDrillStep`) продолжают ленивую инициализацию через
   * `evaluate()` и НЕ регрессируют.
   */
  prefetch?: boolean;
};

const INIT_TIMEOUT_MS = 30_000;

/** Returns true if SharedArrayBuffer is available (COOP/COEP headers set). */
function isMultiThreaded(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
}

/** Select engine file based on cross-origin isolation support. */
function getEngineUrl(): string {
  return isMultiThreaded()
    ? '/stockfish/stockfish-18-lite.js'
    : '/stockfish/stockfish-18-single.js';
}

function parseInfoLine(line: string): EvalLine | null {
  const depthMatch = line.match(/\bdepth (\d+)/);
  const multipvMatch = line.match(/\bmultipv (\d+)/);
  const cpMatch = line.match(/\bscore cp (-?\d+)/);
  const mateMatch = line.match(/\bscore mate (-?\d+)/);
  const pvMatch = line.match(/\bpv (.+)/);
  const nodesMatch = line.match(/\bnodes (\d+)/);
  const npsMatch = line.match(/\bnps (\d+)/);

  if (!depthMatch || !pvMatch) return null;
  if (!cpMatch && !mateMatch) return null;

  return {
    depth: Number(depthMatch[1]),
    multipv: Number(multipvMatch?.[1] ?? 1),
    score: mateMatch
      ? { type: 'mate', value: Number(mateMatch[1]) }
      : { type: 'cp', value: Number(cpMatch![1]) },
    pv: pvMatch[1],
    nodes: nodesMatch ? Number(nodesMatch[1]) : undefined,
    nps: npsMatch ? Number(npsMatch[1]) : undefined,
  };
}

/**
 * Stockfish hook that loads the engine directly as a single Web Worker.
 * No nested workers — avoids browser compatibility issues where creating
 * a Worker from within another Worker fails silently.
 */
export function useStockfish(options: UseStockfishOptions = {}) {
  const {
    depth = 20,
    multiPv = 3,
    // KS-2034: `autoStart` сохранён в типе UseStockfishOptions для
    // обратной совместимости с вызывающим кодом, но реально хук не
    // делает auto-start (старт только по явному `analyze()`).
    // Префикс `_` помечает осознанно неиспользуемое значение.
    autoStart: _autoStart = true,
    skillLevel,
    prefetch = false,
  } = options;

  const depthRef = useRef(depth);
  const multiPvRef = useRef(multiPv);
  const skillLevelRef = useRef<number | undefined>(skillLevel);
  depthRef.current = depth;
  multiPvRef.current = multiPv;
  skillLevelRef.current = skillLevel;

  const [state, setState] = useState<StockfishState>('idle');
  const [lines, setLines] = useState<EvalLine[]>([]);
  const [analysisFen, setAnalysisFen] = useState<string | null>(null);
  const [bestMove, setBestMove] = useState<string | null>(null);
  const engineRef = useRef<Worker | null>(null);
  const fenRef = useRef<string | null>(null);
  const linesBuffer = useRef<Map<number, EvalLine>>(new Map());
  const stateRef = useRef<StockfishState>(state);
  const initTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analysisGenRef = useRef(0);
  const pendingFenRef = useRef<string | null>(null);
  const waitingForReadyRef = useRef(false);
  stateRef.current = state;

  const cleanup = useCallback(() => {
    if (initTimerRef.current) {
      clearTimeout(initTimerRef.current);
      initTimerRef.current = null;
    }
    if (engineRef.current) {
      try {
        engineRef.current.postMessage('quit');
      } catch { /* worker may already be dead */ }
      engineRef.current.terminate();
      engineRef.current = null;
    }
  }, []);

  const init = useCallback(() => {
    cleanup();
    setState('loading');

    const multi = isMultiThreaded();
    let engine: Worker;
    try {
      engine = new Worker(getEngineUrl());
    } catch (err) {
      console.error('[Stockfish] Failed to create engine worker:', err);
      setState('error');
      return;
    }

    initTimerRef.current = setTimeout(() => {
      initTimerRef.current = null;
      if (stateRef.current === 'loading') {
        console.warn(`[Stockfish] Init timeout after ${INIT_TIMEOUT_MS}ms — engine did not respond`);
        setState('error');
      }
    }, INIT_TIMEOUT_MS);

    engine.onmessage = (e: MessageEvent) => {
      const line = typeof e.data === 'string' ? e.data : String(e.data);

      if (line === 'uciok') {
        if (multi) {
          const threads = Math.max(1, (navigator.hardwareConcurrency ?? 2) - 1);
          engine.postMessage(`setoption name Threads value ${threads}`);
        }
        // Опция Skill Level (0..20) — ограничение силы движка для
        // эндшпильного тренажёра (L-24, KS-1800). Отправляется перед
        // первым `go`, чтобы быть в силе с самой первой позиции.
        if (
          skillLevelRef.current !== undefined &&
          skillLevelRef.current >= 0 &&
          skillLevelRef.current <= 20
        ) {
          engine.postMessage(
            `setoption name Skill Level value ${Math.round(skillLevelRef.current)}`,
          );
        }
        engine.postMessage('isready');
        return;
      }

      if (line === 'readyok') {
        if (initTimerRef.current) {
          clearTimeout(initTimerRef.current);
          initTimerRef.current = null;
          // Check for pending FEN queued by lazy-init evaluate call
          const lazyFen = pendingFenRef.current;
          if (lazyFen && engineRef.current) {
            pendingFenRef.current = null;
            linesBuffer.current.clear();
            setLines([]);
            setAnalysisFen(lazyFen);
            setBestMove(null);
            analysisGenRef.current += 1;
            setState('analyzing');
            engine.postMessage(`setoption name MultiPV value ${multiPvRef.current}`);
            engine.postMessage(`position fen ${lazyFen}`);
            engine.postMessage(`go depth ${depthRef.current}`);
          } else {
            setState('ready');
          }
          return;
        }
        // If we were waiting for readyok after stop, dispatch pending eval
        if (waitingForReadyRef.current) {
          waitingForReadyRef.current = false;
          const pendingFen = pendingFenRef.current;
          if (pendingFen && engineRef.current) {
            pendingFenRef.current = null;
            linesBuffer.current.clear();
            setLines([]);
            setAnalysisFen(pendingFen);
            setBestMove(null);
            analysisGenRef.current += 1;
            setState('analyzing');
            engine.postMessage(`setoption name MultiPV value ${multiPvRef.current}`);
            engine.postMessage(`position fen ${pendingFen}`);
            engine.postMessage(`go depth ${depthRef.current}`);
            return;
          }
        }

        setState('ready');
        return;
      }

      if (line.startsWith('info') && line.includes(' pv ')) {
        const info = parseInfoLine(line);
        if (info) {
          linesBuffer.current.set(info.multipv, info);
          const sorted = Array.from(linesBuffer.current.values()).sort(
            (a, b) => a.multipv - b.multipv,
          );
          setLines(sorted);
        }
        return;
      }

      if (line.startsWith('bestmove')) {
        const move = line.split(' ')[1] ?? '';
        setBestMove(move);

        // If there's a pending eval, sync via isready before starting it
        if (pendingFenRef.current && engineRef.current) {
          waitingForReadyRef.current = true;
          engine.postMessage('isready');
          return;
        }

        // Only return to 'ready' if still in 'analyzing' state
        if (stateRef.current === 'analyzing') {
          setState('ready');
        }
      }
    };

    engine.onerror = (err) => {
      console.error('[Stockfish] Engine error:', {
        message: err.message,
        filename: err.filename,
        lineno: err.lineno,
        type: err.type,
      });
      setState('error');
    };

    engine.onmessageerror = (err) => {
      console.error('[Stockfish] Engine message error:', err);
      setState('error');
    };

    engineRef.current = engine;
    engine.postMessage('uci');
  }, [cleanup]);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  // KS-1842: префетч движка при монтировании. Если `prefetch=true` и
  // worker ещё не создан — запускаем `init()`, чтобы загрузка и UCI-
  // инициализация шли параллельно с остальной работой пользователя
  // (скроллинг предыдущих шагов урока). Флаг игнорируется на повторных
  // рендерах, чтобы не пересоздавать движок — guard-условие
  // `!engineRef.current`. Ленивая инициализация через `evaluate()`
  // продолжает работать независимо (для `prefetch=false` поведение
  // не меняется — регрессии не допущены).
  useEffect(() => {
    if (!prefetch) return;
    if (engineRef.current) return;
    init();
    // init-cleanup уже навешен отдельным useEffect выше — здесь ничего
    // отменять не надо.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefetch]);

  const evaluate = useCallback(
    (fen: string) => {
      const s = stateRef.current;
      fenRef.current = fen;

      // Lazy init: if engine not started yet, init and queue the FEN
      if (s === 'idle' && !engineRef.current) {
        pendingFenRef.current = fen;
        init();
        return;
      }

      if (!engineRef.current || s === 'loading' || s === 'error') return;

      // If engine is currently analyzing, stop it and queue the new FEN.
      // The bestmove handler will trigger isready → readyok → start new analysis.
      if (s === 'analyzing') {
        pendingFenRef.current = fen;
        engineRef.current.postMessage('stop');
        return;
      }

      // Engine is ready — start analysis immediately
      pendingFenRef.current = null;
      linesBuffer.current.clear();
      setLines([]);
      setAnalysisFen(fen);
      setBestMove(null);
      analysisGenRef.current += 1;
      setState('analyzing');
      engineRef.current.postMessage(`setoption name MultiPV value ${multiPvRef.current}`);
      engineRef.current.postMessage(`position fen ${fen}`);
      engineRef.current.postMessage(`go depth ${depthRef.current}`);
    },
    [init],
  );

  const stop = useCallback(() => {
    if (!engineRef.current) return;
    engineRef.current.postMessage('stop');
    // Don't clear pendingFenRef — let pending analysis continue via bestmove handler.
    // Don't change state — bestmove handler will transition appropriately.
  }, []);

  return {
    state,
    lines,
    analysisFen,
    bestMove,
    evaluate,
    stop,
    init,
    cleanup,
    isReady: state === 'idle' || state === 'ready' || state === 'analyzing',
  };
}
