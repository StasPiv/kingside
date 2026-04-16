import { useRef, useEffect, useCallback } from 'react';
import { sendClientLog } from '../utils/clientLogger';

function levelToSettings(level: number) {
  const clamped = Math.max(1, Math.min(10, level));
  return {
    skillLevel: Math.round((clamped - 1) * (20 / 9)),
    depth: Math.min(1 + Math.round(clamped * 1.7), 18),
    movetime: Math.round(50 + (clamped - 1) * 217),
  };
}

/** How long we wait for Stockfish to initialize before giving up. */
const READY_TIMEOUT_MS = 10_000;
/** Polling step while waiting for engine ready. */
const READY_POLL_MS = 50;

export function useBotEngine(gameId: string | undefined, botLevel: number | null, isActive: boolean) {
  const workerRef = useRef<Worker | null>(null);
  const readyRef = useRef(false);
  const readyPromiseRef = useRef<Promise<void> | null>(null);
  const readyResolveRef = useRef<(() => void) | null>(null);
  const readyRejectRef = useRef<((err: Error) => void) | null>(null);
  const levelRef = useRef(botLevel);
  levelRef.current = botLevel;

  useEffect(() => {
    if (!isActive || botLevel == null) return;
    sendClientLog('bot', `worker start: game=${gameId?.slice(0, 8)} level=${botLevel}`);

    const worker = new Worker('/stockfish/stockfish-18-single.js');
    workerRef.current = worker;
    readyRef.current = false;

    // Create a ready promise so getBotMove() can await engine init.
    readyPromiseRef.current = new Promise<void>((resolve, reject) => {
      readyResolveRef.current = resolve;
      readyRejectRef.current = reject;
    });

    const readyTimeout = setTimeout(() => {
      if (!readyRef.current) {
        sendClientLog('bot-error', `worker ready timeout after ${READY_TIMEOUT_MS}ms`);
        readyRejectRef.current?.(new Error('Engine init timeout'));
      }
    }, READY_TIMEOUT_MS);

    const onMessage = (e: MessageEvent) => {
      if (typeof e.data === 'string' && e.data.includes('uciok')) {
        const s = levelToSettings(botLevel);
        worker.postMessage(`setoption name Skill Level value ${s.skillLevel}`);
        worker.postMessage('setoption name Threads value 1');
        worker.postMessage('isready');
      }
      if (typeof e.data === 'string' && e.data.includes('readyok')) {
        if (!readyRef.current) {
          readyRef.current = true;
          clearTimeout(readyTimeout);
          sendClientLog('bot', `worker ready: game=${gameId?.slice(0, 8)}`);
          readyResolveRef.current?.();
        }
      }
    };
    const onError = (ev: ErrorEvent) => {
      sendClientLog('bot-error', `worker error: game=${gameId?.slice(0, 8)} msg=${ev.message ?? 'unknown'}`);
      readyRejectRef.current?.(new Error(`Worker error: ${ev.message ?? 'unknown'}`));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage('uci');

    return () => {
      clearTimeout(readyTimeout);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.terminate();
      workerRef.current = null;
      readyRef.current = false;
      readyPromiseRef.current = null;
      readyResolveRef.current = null;
      readyRejectRef.current = null;
    };
  }, [gameId, botLevel, isActive]);

  const waitForReady = useCallback(async (): Promise<void> => {
    if (readyRef.current) return;
    const promise = readyPromiseRef.current;
    if (!promise) {
      // Worker hasn't been created yet (effect hasn't run or bot not active).
      // Poll briefly to give the effect a chance to run.
      const start = Date.now();
      while (!readyPromiseRef.current && Date.now() - start < READY_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, READY_POLL_MS));
      }
      if (!readyPromiseRef.current) {
        throw new Error('Engine not initialized');
      }
      await readyPromiseRef.current;
      return;
    }
    await promise;
  }, []);

  const getBotMove = useCallback(async (fen: string): Promise<string> => {
    const fenShort = fen.split(' ')[0].slice(0, 20);
    sendClientLog('bot', `getBotMove: fen=${fenShort}`);

    // Wait for engine to be fully initialized before requesting a move.
    try {
      await waitForReady();
    } catch (err: any) {
      sendClientLog('bot-error', `getBotMove: engine not ready — ${err?.message ?? 'unknown'}`);
      throw err;
    }

    return new Promise((resolve, reject) => {
      const worker = workerRef.current;
      if (!worker) {
        sendClientLog('bot-error', `getBotMove: worker gone after ready`);
        reject(new Error('Engine worker missing'));
        return;
      }

      const level = levelRef.current ?? 5;
      const s = levelToSettings(level);
      const timer = setTimeout(() => {
        worker.removeEventListener('message', handler);
        sendClientLog('bot-error', `getBotMove: timeout after ${s.movetime + 5000}ms`);
        reject(new Error('Engine timeout'));
      }, s.movetime + 5000);

      const handler = (e: MessageEvent) => {
        const msg = typeof e.data === 'string' ? e.data : '';
        const match = msg.match(/^bestmove\s+(\S+)/);
        if (match) {
          clearTimeout(timer);
          worker.removeEventListener('message', handler);
          sendClientLog('bot', `getBotMove: result=${match[1]}`);
          resolve(match[1]);
        }
      };

      worker.addEventListener('message', handler);
      worker.postMessage(`position fen ${fen}`);
      worker.postMessage(`go depth ${s.depth} movetime ${s.movetime}`);
    });
  }, [waitForReady]);

  return { getBotMove };
}
