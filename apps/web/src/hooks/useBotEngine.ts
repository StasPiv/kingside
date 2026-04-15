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

export function useBotEngine(gameId: string | undefined, botLevel: number | null, isActive: boolean) {
  const workerRef = useRef<Worker | null>(null);
  const readyRef = useRef(false);
  const levelRef = useRef(botLevel);
  levelRef.current = botLevel;

  useEffect(() => {
    if (!isActive || botLevel == null) return;
    sendClientLog('bot', `worker start: game=${gameId?.slice(0, 8)} level=${botLevel}`);

    const worker = new Worker('/stockfish/stockfish-18-single.js');
    workerRef.current = worker;
    readyRef.current = false;

    const onMessage = (e: MessageEvent) => {
      if (typeof e.data === 'string' && e.data.includes('uciok')) {
        const s = levelToSettings(botLevel);
        worker.postMessage(`setoption name Skill Level value ${s.skillLevel}`);
        worker.postMessage('setoption name Threads value 1');
        worker.postMessage('isready');
      }
      if (typeof e.data === 'string' && e.data.includes('readyok')) {
        readyRef.current = true;
        sendClientLog('bot', `worker ready: game=${gameId?.slice(0, 8)}`);
      }
    };
    const onError = (ev: ErrorEvent) => {
      sendClientLog('bot-error', `worker error: game=${gameId?.slice(0, 8)} msg=${ev.message ?? 'unknown'}`);
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage('uci');

    return () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.terminate();
      workerRef.current = null;
      readyRef.current = false;
    };
  }, [gameId, botLevel, isActive]);

  const getBotMove = useCallback((fen: string): Promise<string> => {
    const fenShort = fen.split(' ')[0].slice(0, 20);
    sendClientLog('bot', `getBotMove: fen=${fenShort}`);
    return new Promise((resolve, reject) => {
      const worker = workerRef.current;
      if (!worker) {
        sendClientLog('bot-error', `getBotMove: engine not ready`);
        reject(new Error('Engine not ready'));
        return;
      }

      const level = levelRef.current ?? 5;
      const s = levelToSettings(level);
      const timer = setTimeout(() => {
        sendClientLog('bot-error', `getBotMove: timeout after ${s.movetime}ms`);
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
  }, []);

  return { getBotMove };
}
