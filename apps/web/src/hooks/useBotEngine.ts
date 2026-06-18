import { useRef, useEffect, useCallback, useState } from 'react';
import { sendClientLog } from '../utils/clientLogger';
import {
  STOCKFISH_ENGINE_JS_URL,
  isStockfishMultiThreaded,
  prefetchStockfishWasm,
} from '../lib/stockfishLoader';
import { logBotEngineDebug } from '../lib/botEngineDebug';

// KS-4308: пишем те же события и в UI-видимый буфер для отладочной
// панели пользователя `Stanislav` (см. `BotEngineDebugPanel`).
// Параллельно с `sendClientLog` — тот уходит в server-side лог, а
// `logBotEngineDebug` рисуется в UI и копируется пользователем.
function dualLog(
  level: 'info' | 'warn' | 'error',
  message: string,
): void {
  sendClientLog(level, message);
  logBotEngineDebug(level, message);
}

function levelToSettings(level: number) {
  const clamped = Math.max(1, Math.min(10, level));
  return {
    skillLevel: Math.round((clamped - 1) * (20 / 9)),
    depth: Math.min(1 + Math.round(clamped * 1.7), 18),
    movetime: Math.round(50 + (clamped - 1) * 217),
  };
}

/**
 * KS-4303: было 10 с — на мобильных сетях первая холодная загрузка
 * 7 МБ wasm не успевала, движок «навсегда» переходил в ошибку и игра
 * «работала через раз». Приводим к таймауту `useStockfish` (30 с).
 */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 50;

/** Тип ошибки инициализации, прокидывается в UI для retry-кнопки. */
export type BotEngineErrorReason =
  | 'no_coi'
  | 'wasm_fetch_failed'
  | 'worker_error'
  | 'init_timeout';

/**
 * KS-4335: остатки времени на часах обеих сторон + инкременты в мс.
 * Передаются в `getBotMove`, чтобы Stockfish сам распределил думание
 * через UCI `go wtime btime winc binc` — это даёт неравномерный
 * человеческий расход времени и автоматическое ускорение в цейтноте.
 */
export interface BotClockInfo {
  wtimeMs: number;
  btimeMs: number;
  wincMs?: number;
  bincMs?: number;
}

/**
 * Local Stockfish 18 WASM movegen для **client-side** Play vs Bot.
 *
 * KS-4303: до этой задачи воркер создавался напрямую `new Worker(...)`
 * без предварительной загрузки `.wasm` и с 10-секундным таймаутом.
 * На мобильной сети WASM (7 МБ) часто не успевал — `uciok`/`readyok`
 * не приходили, `waitForReady()` отклонял промис, и игра «работала
 * через раз». Сейчас:
 *
 *   1. Гейт `crossOriginIsolated` — без COOP/COEP заголовков lite-
 *      сборка не запустится, отдаём ошибку моментально.
 *   2. `prefetchStockfishWasm()` — тот же путь, что у `useStockfish`
 *      на странице анализа: тянем wasm с прогрессом через `fetch`,
 *      потом `new Worker(...)` достаёт его из HTTP-кэша.
 *   3. Таймаут 30 с (вместо 10) — соответствует таймауту анализа.
 *   4. `engineRetry()` — пересоздаёт воркер после ошибки без
 *      перемонтирования компонента. UI (`LocalBotGamePage`) показывает
 *      кнопку «Запустить движок ещё раз» при `engineError !== null`.
 */
export function useBotEngine(
  gameId: string | undefined,
  botLevel: number | null,
  isActive: boolean,
) {
  const workerRef = useRef<Worker | null>(null);
  const readyRef = useRef(false);
  const readyPromiseRef = useRef<Promise<void> | null>(null);
  const readyResolveRef = useRef<(() => void) | null>(null);
  const readyRejectRef = useRef<((err: Error) => void) | null>(null);
  const levelRef = useRef(botLevel);
  levelRef.current = botLevel;

  /** Счётчик retry — меняется → useEffect ниже пересоздаёт воркер. */
  const [retryNonce, setRetryNonce] = useState(0);
  const [engineError, setEngineError] = useState<BotEngineErrorReason | null>(
    null,
  );

  useEffect(() => {
    if (!isActive || botLevel == null) return;

    dualLog(
      'info',
      `[bot] mount: game=${gameId?.slice(0, 8)} level=${botLevel} retry=${retryNonce} coi=${
        typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : 'undef'
      } sab=${typeof SharedArrayBuffer !== 'undefined'}`,
    );

    // KS-4303: моментальный отказ если COOP/COEP не настроены — lite
    // сборка без SharedArrayBuffer не стартует, нет смысла ждать
    // 30 секунд таймаута.
    if (!isStockfishMultiThreaded()) {
      dualLog(
        'error',
        `[bot] abort: crossOriginIsolated=false (COOP/COEP missing)`,
      );
      setEngineError('no_coi');
      return;
    }

    dualLog(
      'info',
      `[bot] worker start: game=${gameId?.slice(0, 8)} level=${botLevel} retry=${retryNonce}`,
    );

    readyRef.current = false;
    setEngineError(null);

    // Промис готовности создаём СРАЗУ, до async preload — чтобы вызов
    // `getBotMove()` параллельно с initом мог await'ить тот же промис,
    // а не уйти в poll-loop.
    readyPromiseRef.current = new Promise<void>((resolve, reject) => {
      readyResolveRef.current = resolve;
      readyRejectRef.current = reject;
    });

    const abort = new AbortController();
    let worker: Worker | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const onMessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string') return;
      if (e.data.includes('uciok')) {
        dualLog('info', `[bot] uciok received`);
        const s = levelToSettings(botLevel);
        worker?.postMessage(`setoption name Skill Level value ${s.skillLevel}`);
        worker?.postMessage('setoption name Threads value 1');
        worker?.postMessage('isready');
      }
      if (e.data.includes('readyok')) {
        if (!readyRef.current) {
          readyRef.current = true;
          if (readyTimer) clearTimeout(readyTimer);
          dualLog('info', `[bot] readyok — worker ready: game=${gameId?.slice(0, 8)}`);
          readyResolveRef.current?.();
        }
      }
    };

    const onError = (ev: ErrorEvent) => {
      dualLog(
        'error',
        `[bot] worker error: game=${gameId?.slice(0, 8)} msg=${ev.message ?? 'unknown'}`,
      );
      setEngineError('worker_error');
      readyRejectRef.current?.(new Error(`Worker error: ${ev.message ?? 'unknown'}`));
    };

    void (async () => {
      // 1) Предзагружаем wasm через fetch с прогрессом — это самый
      //    тяжёлый шаг (~7 МБ), на мобильной сети он и был причиной
      //    таймаута. После успеха wasm попадает в HTTP-кэш браузера,
      //    и Worker при создании достанет его оттуда.
      const tPrefetch = performance.now();
      dualLog('info', `[bot] prefetch wasm start`);
      try {
        await prefetchStockfishWasm(abort.signal);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') {
          dualLog('warn', `[bot] prefetch aborted (cleanup)`);
          return;
        }
        dualLog(
          'error',
          `[bot] prefetch failed: ${(err as Error)?.message ?? 'unknown'}`,
        );
        if (!cancelled) {
          setEngineError('wasm_fetch_failed');
          readyRejectRef.current?.(
            new Error(`wasm fetch failed: ${(err as Error)?.message ?? 'unknown'}`),
          );
        }
        return;
      }
      dualLog(
        'info',
        `[bot] prefetch ok (${Math.round(performance.now() - tPrefetch)}ms)`,
      );
      if (cancelled) return;

      // 2) Создаём worker. После prefetch wasm обычно уже в кэше и
      //    инициализация uci/readyok занимает доли секунды.
      try {
        worker = new Worker(STOCKFISH_ENGINE_JS_URL);
        dualLog('info', `[bot] new Worker created`);
      } catch (err) {
        dualLog(
          'error',
          `[bot] worker create failed: ${(err as Error)?.message ?? 'unknown'}`,
        );
        setEngineError('worker_error');
        readyRejectRef.current?.(
          new Error(`Worker create failed: ${(err as Error)?.message ?? 'unknown'}`),
        );
        return;
      }
      workerRef.current = worker;

      readyTimer = setTimeout(() => {
        if (!readyRef.current) {
          dualLog(
            'error',
            `[bot] worker ready timeout after ${READY_TIMEOUT_MS}ms`,
          );
          setEngineError('init_timeout');
          readyRejectRef.current?.(new Error('Engine init timeout'));
        }
      }, READY_TIMEOUT_MS);

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage('uci');
      dualLog('info', `[bot] sent uci command`);
    })();

    return () => {
      cancelled = true;
      abort.abort();
      if (readyTimer) clearTimeout(readyTimer);
      if (worker) {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        try {
          worker.terminate();
        } catch {
          /* worker may already be dead */
        }
      }
      workerRef.current = null;
      readyRef.current = false;
      readyPromiseRef.current = null;
      readyResolveRef.current = null;
      readyRejectRef.current = null;
    };
  }, [gameId, botLevel, isActive, retryNonce]);

  const waitForReady = useCallback(async (): Promise<void> => {
    if (readyRef.current) return;
    const promise = readyPromiseRef.current;
    if (!promise) {
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

  const getBotMove = useCallback(
    async (fen: string, clock?: BotClockInfo): Promise<string> => {
      const fenShort = fen.split(' ')[0].slice(0, 20);
      const level = levelRef.current ?? 5;
      const s = levelToSettings(level);

      // KS-4335: если переданы остатки на часах — отдаём их Stockfish'у
      // в `go wtime btime winc binc`, движок сам распределит время на
      // ход. Это даёт неравномерный «человеческий» расход времени:
      // дебют — быстро, критичная позиция — дольше, цейтнот — почти
      // мгновенно. В этом режиме НЕ ограничиваем `depth`/`movetime`,
      // иначе они доминируют и снова получается мгновенный ход на
      // низких уровнях. Силу регулирует Skill Level (выставляется при
      // uciok). Без часов (`clock` не передан или noClock) — старый
      // путь `go depth ... movetime ...`, чтобы не сломать сценарии,
      // где время не отслеживается.
      const useClock =
        clock != null &&
        Number.isFinite(clock.wtimeMs) &&
        Number.isFinite(clock.btimeMs) &&
        clock.wtimeMs > 0 &&
        clock.btimeMs > 0;

      const goCmd = useClock
        ? `go wtime ${Math.max(1, Math.round(clock!.wtimeMs))}` +
          ` btime ${Math.max(1, Math.round(clock!.btimeMs))}` +
          ` winc ${Math.max(0, Math.round(clock!.wincMs ?? 0))}` +
          ` binc ${Math.max(0, Math.round(clock!.bincMs ?? 0))}`
        : `go depth ${s.depth} movetime ${s.movetime}`;

      // Таймаут берётся от стороны, чей ход сейчас (по fen — половина
      // после первого пробела). В режиме `go wtime btime` Stockfish
      // может думать заметно дольше движкового `movetime`, и старого
      // лимита `movetime + 5000` не хватит на классических контролях.
      const sideToMove = fen.split(' ')[1] === 'b' ? 'b' : 'w';
      const ownTimeMs = useClock
        ? sideToMove === 'w'
          ? clock!.wtimeMs
          : clock!.btimeMs
        : s.movetime;
      // Stockfish тратит максимум долю от своего остатка; берём весь
      // остаток + запас 5 c как верхнюю границу ожидания bestmove.
      const timeoutMs = Math.max(5_000, Math.round(ownTimeMs) + 5_000);

      dualLog(
        'info',
        useClock
          ? `[bot] getBotMove req: fen=${fenShort} wtime=${Math.round(clock!.wtimeMs)} btime=${Math.round(clock!.btimeMs)} winc=${Math.round(clock!.wincMs ?? 0)} binc=${Math.round(clock!.bincMs ?? 0)}`
          : `[bot] getBotMove req: fen=${fenShort} depth=${s.depth} movetime=${s.movetime}`,
      );

      try {
        await waitForReady();
      } catch (err: any) {
        dualLog(
          'error',
          `[bot] getBotMove: engine not ready — ${err?.message ?? 'unknown'}`,
        );
        throw err;
      }

      return new Promise((resolve, reject) => {
        const worker = workerRef.current;
        if (!worker) {
          dualLog('error', `[bot] getBotMove: worker gone after ready`);
          reject(new Error('Engine worker missing'));
          return;
        }

        const timer = setTimeout(() => {
          worker.removeEventListener('message', handler);
          dualLog('error', `[bot] getBotMove: timeout after ${timeoutMs}ms`);
          reject(new Error('Engine timeout'));
        }, timeoutMs);

        const handler = (e: MessageEvent) => {
          const msg = typeof e.data === 'string' ? e.data : '';
          const match = msg.match(/^bestmove\s+(\S+)/);
          if (match) {
            clearTimeout(timer);
            worker.removeEventListener('message', handler);
            dualLog('info', `[bot] bestmove ${match[1]}`);
            resolve(match[1]);
          }
        };

        worker.addEventListener('message', handler);
        worker.postMessage(`position fen ${fen}`);
        worker.postMessage(goCmd);
      });
    },
    [waitForReady],
  );

  /**
   * KS-4303: ручной retry после ошибки инициализации (таймаут wasm,
   * worker error, no_coi). Сбрасывает `engineError`, инкрементирует
   * `retryNonce` → useEffect выше пересоздаёт воркер.
   */
  const retryEngine = useCallback(() => {
    dualLog('info', `[bot] retry engine init (user clicked)`);
    setEngineError(null);
    setRetryNonce((n) => n + 1);
  }, []);

  return { getBotMove, engineError, retryEngine };
}
