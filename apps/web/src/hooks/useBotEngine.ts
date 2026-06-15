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

/**
 * Local Stockfish 18 WASM movegen для **client-side** Play vs Bot.
 *
 * Активируется хуком ТОЛЬКО когда у партии `botClientSide=true`:
 *   - Workshop / Play-vs-Bot (`STOCKFISH_BOT_ID`, явный режим);
 *   - KS-3559: matchmaking 30-секундный fallback на бот из
 *     `MATCHMAKING_BOTS` (восстановлено после отката synthetic users).
 *
 * KS-2165 (F1, доку-маркер) → KS-3559: между этими тикетами хук не
 * запускался из matchmaking, потому что backend перестал выставлять
 * `botClientSide=true` (был эксперимент с synthetic users, откатан).
 * Сейчас восстановлено старое поведение: caller (`GamePage`) передаёт
 * `isActive = isBot && botClientSide !== false`. Для будущих
 * server-side ботов (ADR-034 v2 WS-bot-fleet) backend будет шлёт
 * `botClientSide=false` — хук не стартует, ход придёт обычным
 * `game:move` событием с сервера.
 */
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
    sendClientLog('info', `[bot] worker start: game=${gameId?.slice(0, 8)} level=${botLevel}`);

    // KS-4147: `/stockfish/stockfish-18-single.js` больше не выкладывается
    // на S3 (см. useStockfish.ts комментарий — Single-thread fallback
    // снят, lite требует COOP/COEP, которые уже включены на CloudFront).
    // Старый путь приводил к зависанию: Worker создавался, но `uciok`
    // не приходил, getBotMove ждал 10с readyTimeout → промис
    // отклонялся, в LocalBotGamePage оставалось «Bot is thinking…».
    // Используем lite-воркер — тот же файл, что и в /analysis,
    // /game-review и других местах.
    const worker = new Worker('/stockfish/stockfish-18-lite.js');
    workerRef.current = worker;
    readyRef.current = false;

    // Create a ready promise so getBotMove() can await engine init.
    readyPromiseRef.current = new Promise<void>((resolve, reject) => {
      readyResolveRef.current = resolve;
      readyRejectRef.current = reject;
    });

    const readyTimeout = setTimeout(() => {
      if (!readyRef.current) {
        sendClientLog('error', `[bot] worker ready timeout after ${READY_TIMEOUT_MS}ms`);
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
          sendClientLog('info', `[bot] worker ready: game=${gameId?.slice(0, 8)}`);
          readyResolveRef.current?.();
        }
      }
    };
    const onError = (ev: ErrorEvent) => {
      sendClientLog('error', `[bot] worker error: game=${gameId?.slice(0, 8)} msg=${ev.message ?? 'unknown'}`);
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
    sendClientLog('info', `[bot] getBotMove: fen=${fenShort}`);

    // Wait for engine to be fully initialized before requesting a move.
    try {
      await waitForReady();
    } catch (err: any) {
      sendClientLog('error', `[bot] getBotMove: engine not ready — ${err?.message ?? 'unknown'}`);
      throw err;
    }

    return new Promise((resolve, reject) => {
      const worker = workerRef.current;
      if (!worker) {
        sendClientLog('error', `[bot] getBotMove: worker gone after ready`);
        reject(new Error('Engine worker missing'));
        return;
      }

      const level = levelRef.current ?? 5;
      const s = levelToSettings(level);
      const timer = setTimeout(() => {
        worker.removeEventListener('message', handler);
        sendClientLog('error', `[bot] getBotMove: timeout after ${s.movetime + 5000}ms`);
        reject(new Error('Engine timeout'));
      }, s.movetime + 5000);

      const handler = (e: MessageEvent) => {
        const msg = typeof e.data === 'string' ? e.data : '';
        const match = msg.match(/^bestmove\s+(\S+)/);
        if (match) {
          clearTimeout(timer);
          worker.removeEventListener('message', handler);
          sendClientLog('info', `[bot] getBotMove: result=${match[1]}`);
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
