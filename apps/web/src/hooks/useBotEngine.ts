import { useRef, useEffect, useCallback } from 'react';

/**
 * Bot level → Stockfish UCI settings.
 * Level 1 = weakest (Skill Level 0, depth 1, 50ms)
 * Level 10 = strongest (Skill Level 20, depth 18, 2000ms)
 */
function levelToSettings(level: number) {
  const clamped = Math.max(1, Math.min(10, level));
  return {
    skillLevel: Math.round((clamped - 1) * (20 / 9)),       // 0..20
    depth: Math.min(1 + Math.round(clamped * 1.7), 18),     // 1..18
    movetime: Math.round(50 + (clamped - 1) * 217),         // 50..2000
  };
}

export function useBotEngine(gameId: string | undefined, botLevel: number | null, isActive: boolean) {
  const workerRef = useRef<Worker | null>(null);
  const readyRef = useRef(false);
  const levelRef = useRef(botLevel);
  levelRef.current = botLevel;

  // Init / destroy worker
  useEffect(() => {
    console.log('[BotEngine] effect:', { isActive, botLevel, gameId });
    if (!isActive || botLevel == null) return;
    console.log('[BotEngine] Starting WASM worker, level:', botLevel);

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
      }
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage('uci');

    return () => {
      worker.removeEventListener('message', onMessage);
      worker.terminate();
      workerRef.current = null;
      readyRef.current = false;
    };
  }, [gameId, botLevel, isActive]);

  const getBotMove = useCallback((fen: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const worker = workerRef.current;
      if (!worker) { reject(new Error('Engine not ready')); return; }

      const level = levelRef.current ?? 5;
      const s = levelToSettings(level);
      const timeout = s.movetime + 5000;
      const timer = setTimeout(() => { reject(new Error('Engine timeout')); }, timeout);

      const handler = (e: MessageEvent) => {
        const msg = typeof e.data === 'string' ? e.data : '';
        const match = msg.match(/^bestmove\s+(\S+)/);
        if (match) {
          clearTimeout(timer);
          worker.removeEventListener('message', handler);
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
