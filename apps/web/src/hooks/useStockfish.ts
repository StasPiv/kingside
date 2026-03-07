import { useState, useEffect, useRef, useCallback } from 'react';
import type { InfoLine } from '../workers/stockfish.worker';

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

type OutMessage =
  | { type: 'ready' }
  | { type: 'info'; data: InfoLine }
  | { type: 'bestmove'; move: string }
  | { type: 'error'; message: string };

export function useStockfish(options: UseStockfishOptions = {}) {
  const { depth = 20, multiPv = 3, autoStart = true } = options;

  const [state, setState] = useState<StockfishState>('idle');
  const [lines, setLines] = useState<EvalLine[]>([]);
  const [bestMove, setBestMove] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const fenRef = useRef<string | null>(null);
  const linesBuffer = useRef<Map<number, EvalLine>>(new Map());

  const cleanup = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'quit' });
      workerRef.current.terminate();
      workerRef.current = null;
    }
  }, []);

  const init = useCallback(() => {
    cleanup();
    setState('loading');

    const worker = new Worker(
      new URL('../workers/stockfish.worker.ts', import.meta.url),
      { type: 'module' },
    );

    worker.onmessage = (e: MessageEvent<OutMessage>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'ready':
          setState('ready');
          break;

        case 'info': {
          const line: EvalLine = {
            depth: msg.data.depth,
            multipv: msg.data.multipv,
            score: msg.data.score,
            pv: msg.data.pv,
            nodes: msg.data.nodes,
            nps: msg.data.nps,
          };
          linesBuffer.current.set(line.multipv, line);
          const sorted = Array.from(linesBuffer.current.values()).sort(
            (a, b) => a.multipv - b.multipv,
          );
          setLines(sorted);
          break;
        }

        case 'bestmove':
          setBestMove(msg.move);
          setState('ready');
          break;

        case 'error':
          console.error('Stockfish error:', msg.message);
          setState('error');
          break;
      }
    };

    worker.onerror = () => {
      setState('error');
    };

    workerRef.current = worker;
    worker.postMessage({ type: 'init' });
  }, [cleanup]);

  useEffect(() => {
    if (autoStart) {
      init();
    }
    return cleanup;
  }, [autoStart, init, cleanup]);

  const evaluate = useCallback(
    (fen: string) => {
      if (!workerRef.current || state === 'loading') return;
      fenRef.current = fen;
      linesBuffer.current.clear();
      setLines([]);
      setBestMove(null);
      setState('analyzing');
      workerRef.current.postMessage({ type: 'eval', fen, depth, multiPv });
    },
    [state, depth, multiPv],
  );

  const stop = useCallback(() => {
    if (!workerRef.current) return;
    workerRef.current.postMessage({ type: 'stop' });
  }, []);

  return {
    state,
    lines,
    bestMove,
    evaluate,
    stop,
    init,
    isReady: state === 'ready' || state === 'analyzing',
  };
}
