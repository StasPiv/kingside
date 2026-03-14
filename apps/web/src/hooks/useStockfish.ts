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
  const { depth = 20, multiPv = 3, autoStart = true } = options;

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
        engine.postMessage('isready');
        return;
      }

      if (line === 'readyok') {
        if (initTimerRef.current) {
          clearTimeout(initTimerRef.current);
          initTimerRef.current = null;
          setState('ready');
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
            engine.postMessage(`setoption name MultiPV value ${multiPv}`);
            engine.postMessage(`position fen ${pendingFen}`);
            engine.postMessage(`go depth ${depth}`);
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
    if (autoStart) {
      init();
    }
    return cleanup;
  }, [autoStart, init, cleanup]);

  const evaluate = useCallback(
    (fen: string) => {
      const s = stateRef.current;
      if (!engineRef.current || s === 'loading' || s === 'idle' || s === 'error') return;
      fenRef.current = fen;

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
      engineRef.current.postMessage(`setoption name MultiPV value ${multiPv}`);
      engineRef.current.postMessage(`position fen ${fen}`);
      engineRef.current.postMessage(`go depth ${depth}`);
    },
    [],
  );

  const stop = useCallback(() => {
    if (!engineRef.current) return;
    pendingFenRef.current = null;
    engineRef.current.postMessage('stop');
    // Transition to ready so UI reflects stopped state
    if (stateRef.current === 'analyzing') {
      setState('ready');
    }
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
    isReady: state === 'ready' || state === 'analyzing',
  };
}
