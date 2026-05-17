import { useState, useEffect, useRef, useCallback } from 'react';
import { Chess } from 'chess.js';

/**
 * KS-3041: Stockfish WASM зависал на позициях с малым числом легальных
 * ходов при `multipv > legalMoves` (наблюдался hang на FEN
 * `8/8/4k3/4P2p/8/P2pR3/P4PP1/3r2K1 w - - 2 51`, где у белых 2 легальных
 * ответа в шахе, а в UI выбран multipv=3). Перед отправкой
 * `setoption name MultiPV value N` клемпим N к фактическому числу
 * легальных ходов: `clamp(requested, 1, legalCount)`. На UI выбор
 * пользователя не меняется — клемпа применяется только в момент
 * команды движку.
 */
export function clampMultiPvToLegalMoves(fen: string, requested: number): number {
  const lower = Math.max(1, Math.floor(requested));
  try {
    const chess = new Chess(fen);
    const legalCount = chess.moves().length;
    if (legalCount === 0) return 1; // mate/stalemate — движок сам сразу отдаст bestmove.
    return Math.min(lower, legalCount);
  } catch {
    // Невалидный FEN — отдаём как просили, дальше движок отвалится сам
    // (а парсер всё равно не должен ронять весь hook).
    return lower;
  }
}

export type EvalLine = {
  depth: number;
  multipv: number;
  score: { type: 'cp' | 'mate'; value: number };
  pv: string;
  nodes?: number;
  nps?: number;
};

type StockfishState = 'idle' | 'loading' | 'ready' | 'analyzing' | 'error';

/**
 * KS-3067: причина ошибки инициализации движка. Используется UI-компонентом
 * `EngineLoader` для подбора понятного сообщения пользователю:
 * - `no_coi`     — `crossOriginIsolated === false` (нет SharedArrayBuffer);
 *                  движок не запускается, сразу error. После KS-3065 COOP/COEP
 *                  стоят на CloudFront, поэтому в норме у всех true.
 * - `load_failed` — fetch wasm-файла упал (сеть/CORS/404/500).
 * - `init_timeout`— worker создан, но за `INIT_TIMEOUT_MS` не пришёл readyok.
 * - `worker_error`— исключение от `engine.onerror`/`onmessageerror`.
 */
export type EngineErrorReason =
  | 'no_coi'
  | 'load_failed'
  | 'init_timeout'
  | 'worker_error'
  | null;

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

/**
 * KS-3065 + KS-3067: после деплоя COOP/COEP заголовков на CloudFront
 * `crossOriginIsolated === true` у всех нормальных клиентов, поэтому
 * загружается ТОЛЬКО lite-версия (7 МБ wasm). Single-thread fallback
 * (`stockfish-18-single.js/.wasm`) на S3 больше не лежит — попытка
 * загрузить дала бы 403 и 30-секундный таймаут. Поэтому если COI=false
 * (расширение/политика браузера/сломанный прокси) — сразу `error` с
 * причиной `no_coi`, без бесполезных fetch'ей.
 */
const ENGINE_JS_URL = '/stockfish/stockfish-18-lite.js';
const ENGINE_WASM_URL = '/stockfish/stockfish-18-lite.wasm';

/** Returns true if SharedArrayBuffer is available (COOP/COEP headers set). */
function isMultiThreaded(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
}

/**
 * KS-3067: предзагрузка wasm с прогресс-баром. Читаем тело ответа потоком
 * (`ReadableStream`) и считаем `loaded / total` из `Content-Length`. После
 * успешного завершения wasm попадает в HTTP-кеш браузера, и Worker при
 * создании достанет его оттуда без повторного сетевого запроса (last-modified
 * + etag на S3 есть → эвристический кеш работает у Chrome/Firefox).
 *
 * Если `Content-Length` отсутствует или `ReadableStream` API не доступен —
 * fallback на `response.arrayBuffer()` без прогресса. UI в этом случае
 * остаётся на 0% до завершения, но загрузка всё равно прерывается на
 * AbortController, и ошибка fetch ловится в catch вызывающей init().
 */
async function prefetchWasm(
  url: string,
  signal: AbortSignal,
  onProgress: (loaded: number, total: number) => void,
): Promise<void> {
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`fetch ${url} → HTTP ${response.status}`);
  }
  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : 0;
  const reader = response.body?.getReader?.();
  if (!reader) {
    // ReadableStream недоступен — старая платформа. Читаем целиком,
    // прогресс остаётся 0 до конца.
    await response.arrayBuffer();
    onProgress(total || 1, total || 1);
    return;
  }
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      loaded += value.byteLength;
      onProgress(loaded, total || loaded);
    }
  }
  // Если total был 0 (S3 не вернул content-length) — финальный 100%.
  onProgress(total || loaded, total || loaded);
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
  const [loadProgress, setLoadProgress] = useState(0);
  const [errorReason, setErrorReason] = useState<EngineErrorReason>(null);
  const engineRef = useRef<Worker | null>(null);
  const fenRef = useRef<string | null>(null);
  const linesBuffer = useRef<Map<number, EvalLine>>(new Map());
  const stateRef = useRef<StockfishState>(state);
  const initTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analysisGenRef = useRef(0);
  const pendingFenRef = useRef<string | null>(null);
  const waitingForReadyRef = useRef(false);
  const fetchAbortRef = useRef<AbortController | null>(null);
  stateRef.current = state;

  const cleanup = useCallback(() => {
    if (initTimerRef.current) {
      clearTimeout(initTimerRef.current);
      initTimerRef.current = null;
    }
    if (fetchAbortRef.current) {
      try { fetchAbortRef.current.abort(); } catch { /* ignore */ }
      fetchAbortRef.current = null;
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
    setErrorReason(null);
    setLoadProgress(0);

    // KS-3067: гейт. Без crossOriginIsolated — single-thread fallback
    // (113 МБ wasm) на S3 нет, новый таймаут просто крутил бы 30s. Сразу
    // даём UI понятную ошибку.
    if (!isMultiThreaded()) {
      setErrorReason('no_coi');
      setState('error');
      return;
    }

    setState('loading');

    const abort = new AbortController();
    fetchAbortRef.current = abort;

    void (async () => {
      // 1) Предзагружаем wasm с прогрессом. Это самый тяжёлый шаг
      //    (≈7 МБ для lite) и определяет UX пользователя на медленной сети.
      try {
        await prefetchWasm(ENGINE_WASM_URL, abort.signal, (loaded, total) => {
          if (total > 0) {
            setLoadProgress(Math.min(0.99, loaded / total));
          }
        });
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return; // cleanup'нули — не считаем ошибкой
        console.error('[Stockfish] Failed to fetch wasm:', err);
        if (stateRef.current === 'loading') {
          setErrorReason('load_failed');
          setState('error');
        }
        return;
      }
      // Cleanup мог сбросить состояние пока шла загрузка.
      if (stateRef.current !== 'loading') return;

      // 2) Создаём worker — он внутри сделает fetch wasm и в нормальных
      //    условиях получит его из HTTP-кеша браузера (мы его только что
      //    положили туда).
      let engine: Worker;
      try {
        engine = new Worker(ENGINE_JS_URL);
      } catch (err) {
        console.error('[Stockfish] Failed to create engine worker:', err);
        setErrorReason('worker_error');
        setState('error');
        return;
      }

      // 3) Таймаут именно на инициализацию (uci handshake + wasm compile).
      initTimerRef.current = setTimeout(() => {
        initTimerRef.current = null;
        if (stateRef.current === 'loading') {
          console.warn(`[Stockfish] Init timeout after ${INIT_TIMEOUT_MS}ms — engine did not respond`);
          setErrorReason('init_timeout');
          setState('error');
        }
      }, INIT_TIMEOUT_MS);

      engine.onmessage = (e: MessageEvent) => {
        const line = typeof e.data === 'string' ? e.data : String(e.data);

        if (line === 'uciok') {
          const threads = Math.max(1, (navigator.hardwareConcurrency ?? 2) - 1);
          engine.postMessage(`setoption name Threads value ${threads}`);
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
            setLoadProgress(1);
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
              // KS-3041: см. clampMultiPvToLegalMoves.
              const effectiveMpv = clampMultiPvToLegalMoves(lazyFen, multiPvRef.current);
              engine.postMessage(`setoption name MultiPV value ${effectiveMpv}`);
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
              // KS-3041: см. clampMultiPvToLegalMoves.
              const effectiveMpv = clampMultiPvToLegalMoves(pendingFen, multiPvRef.current);
              engine.postMessage(`setoption name MultiPV value ${effectiveMpv}`);
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
        setErrorReason('worker_error');
        setState('error');
      };

      engine.onmessageerror = (err) => {
        console.error('[Stockfish] Engine message error:', err);
        setErrorReason('worker_error');
        setState('error');
      };

      engineRef.current = engine;
      engine.postMessage('uci');
    })();
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

      if (!engineRef.current || s === 'loading' || s === 'error') {
        // Если ещё идёт загрузка wasm — запомним fen, он подхватится
        // в readyok-handler'е после успешной инициализации.
        if (s === 'loading') pendingFenRef.current = fen;
        return;
      }

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
      // KS-3041: см. clampMultiPvToLegalMoves.
      const effectiveMpv = clampMultiPvToLegalMoves(fen, multiPvRef.current);
      engineRef.current.postMessage(`setoption name MultiPV value ${effectiveMpv}`);
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

  /**
   * KS-3042: при изменении `multiPv` в UI во время активного анализа
   * нужно переотправить `setoption MultiPV` и заново стартовать `go` —
   * Stockfish не подхватывает MultiPV «на лету» без рестарта поиска.
   *
   * Используем уже существующий путь `evaluate(currentFen)`: при
   * `stateRef.current === 'analyzing'` он сложит fen в `pendingFenRef`
   * и отправит `stop`. Дальше bestmove-handler сделает `isready`,
   * после `readyok` уйдёт `setoption MultiPV value <clamp(...)>` с
   * актуальным `multiPvRef.current` + `position` + `go` (см. блок
   * `waitingForReadyRef`). Клемпа KS-3041 сохраняется — она читается
   * на момент re-dispatch'а из ref.
   *
   * Если движок не активен (idle/ready/loading) — ничего не делаем,
   * следующий обычный `evaluate()` подхватит новый `multiPvRef`
   * через те же 3 точки отправки setoption.
   */
  useEffect(() => {
    if (stateRef.current !== 'analyzing') return;
    if (!engineRef.current) return;
    const fen = fenRef.current;
    if (!fen) return;
    evaluate(fen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiPv]);

  /**
   * KS-3085: при изменении `depth` (слайдер «Максимальная глубина анализа»
   * в EngineSettingsModal) во время активного анализа — переотправить
   * `go depth ...` с новым значением. UCI не подхватывает depth на лету
   * без stop'а текущего поиска. Логика идентична KS-3042 для multiPv:
   * `evaluate(currentFen)` сложит fen в `pendingFenRef`, отправит `stop`,
   * bestmove-handler сделает `isready` → re-dispatch с актуальным
   * `depthRef.current`.
   *
   * Если движок не activиen — ничего не делаем, следующий `evaluate()`
   * сам подхватит новый depth (на момент `go` читается из ref).
   */
  useEffect(() => {
    if (stateRef.current !== 'analyzing') return;
    if (!engineRef.current) return;
    const fen = fenRef.current;
    if (!fen) return;
    evaluate(fen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depth]);

  return {
    state,
    lines,
    analysisFen,
    bestMove,
    evaluate,
    stop,
    init,
    cleanup,
    loadProgress,
    errorReason,
    isReady: state === 'idle' || state === 'ready' || state === 'analyzing',
  };
}
