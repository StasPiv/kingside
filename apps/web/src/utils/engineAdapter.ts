/**
 * EngineAdapter — unified interface for chess engine analysis.
 * Two implementations: WasmEngineAdapter (in-browser Stockfish)
 * and BridgeEngineAdapter (external engine via WebSocket).
 */

/**
 * KS-2526 / KS-2521. WDL-распределение из Stockfish (UCI_ShowWDL=true,
 * см. KS-2525). Все значения в промилле (0..1000), POV side-to-move.
 * Сумма обычно равна 1000, но движок может отдавать ±погрешность —
 * UI должен принимать как есть.
 *
 * Поле опциональное: старые сборки Stockfish или Bridge-engine без
 * WDL-патча (см. KS-2521) не присылают `wdl ...` в info, парсер
 * возвращает `undefined`.
 */
export type WdlDistribution = {
  /** Wins per mille (0..1000), POV side-to-move. */
  w: number;
  /** Draws per mille. */
  d: number;
  /** Losses per mille. */
  l: number;
};

export type InfoLine = {
  multipv: number;
  depth: number;
  score: { type: 'cp' | 'mate'; value: number };
  pv: string[];
  /** KS-2526: распределение W/D/L (опционально). */
  wdl?: WdlDistribution;
};

export type AnalysisResult = {
  lines: InfoLine[];
  bestByDepth: Map<number, string>;
  evalByDepth: Map<number, number>;
  firstAppearance: number;
};

export interface EngineAdapter {
  init(): Promise<void>;
  setOption(name: string, value: string): void;
  /**
   * KS-2955: опциональный `movetimeMs` — нижний порог времени на анализ
   * (мс). Если задан — `go depth N movetime M` (SF останавливается по
   * первому достигнутому условию).
   *
   * KS-3364: опциональный `nodes` — лимит по числу позиций анализа.
   * В WASM-команде превращается в `go nodes N`.
   *
   * KS-3380: опциональный `searchmoves` — ограничивает root-moves SF
   * только перечисленными UCI-ходами (`go searchmoves m1 m2 …`).
   * Используется в PVE-runner для классификации: после хода игрока
   * запускаем pre-frame analyze с `searchmoves=[playedUci]` чтобы
   * получить WDL именно сыгранного хода в той же фрейме (на той же
   * глубине), что и bestUci-snapshot. Решает баг KS-3380 — раньше
   * `wdlAfter` снимался отдельным post-analyze в позиции после хода,
   * и расхождение pre vs post на WASM (depth 18 / 1s movetime) давало
   * ложные `?!` даже на лучших ходах.
   */
  analyze(
    fen: string,
    depth: number,
    multiPv: number,
    movetimeMs?: number,
    nodes?: number,
    searchmoves?: ReadonlyArray<string>,
  ): Promise<AnalysisResult>;
  destroy(): void;
}

// ─── Shared helpers ───

export function parseInfoLine(line: string): InfoLine | null {
  const depthMatch = line.match(/\bdepth (\d+)/);
  const pvMatch = line.match(/\bpv (.+)/);
  if (!depthMatch || !pvMatch) return null;

  const depth = parseInt(depthMatch[1], 10);
  const multipvMatch = line.match(/\bmultipv (\d+)/);
  const multipv = multipvMatch ? parseInt(multipvMatch[1], 10) : 1;
  // KS-2526: захват `wdl W D L` ДО split(pv), потому что pv — последняя
  // секция info, и токены wdl находятся раньше неё. Парсим из всей
  // строки, чтобы не зависеть от порядка с другими полями.
  let wdl: WdlDistribution | undefined;
  const wdlMatch = line.match(/\bwdl (\d+) (\d+) (\d+)/);
  if (wdlMatch) {
    wdl = {
      w: parseInt(wdlMatch[1], 10),
      d: parseInt(wdlMatch[2], 10),
      l: parseInt(wdlMatch[3], 10),
    };
  }
  // pv может содержать `wdl 800 150 50` если он попал в хвост; чтобы
  // не сломать pv-токены, используем pvMatch до wdl-фильтрации. По
  // спецификации UCI pv — последний токен, поэтому захват `(.+)`
  // безопасен: wdl всегда стоит ДО pv.
  const pv = pvMatch[1].split(/\s+/);

  let score: { type: 'cp' | 'mate'; value: number };
  const cpMatch = line.match(/\bscore cp (-?\d+)/);
  const mateMatch = line.match(/\bscore mate (-?\d+)/);
  if (mateMatch) {
    score = { type: 'mate', value: parseInt(mateMatch[1], 10) };
  } else if (cpMatch) {
    score = { type: 'cp', value: parseInt(cpMatch[1], 10) };
  } else {
    return null;
  }

  return { depth, multipv, score, pv, ...(wdl ? { wdl } : {}) };
}

function buildResult(
  finalLines: Map<number, InfoLine>,
  bestByDepth: Map<number, string>,
  evalByDepth: Map<number, number>,
  targetDepth: number,
): AnalysisResult {
  const lines = Array.from(finalLines.values()).sort((a, b) => a.multipv - b.multipv);
  const finalBest = lines.length > 0 ? lines[0].pv[0] : '';

  let firstAppearance = targetDepth;
  for (let d = 1; d <= targetDepth; d++) {
    if (bestByDepth.get(d) === finalBest) {
      firstAppearance = d;
      break;
    }
  }

  return { lines, bestByDepth, evalByDepth, firstAppearance };
}

function scoreToCP(score: { type: 'cp' | 'mate'; value: number }): number {
  if (score.type === 'mate') {
    const dist = Math.abs(score.value);
    const base = 10000 - (dist - 1) * 100;
    return score.value > 0 ? base : -base;
  }
  return score.value;
}

// ─── WASM Adapter ───

/**
 * KS-3170 (регрессия KS-3067): причина init-фейла, прокидываемая наружу
 * через `onError` callback. Совпадает по семантике с `EngineErrorReason`
 * из `useStockfish`, чтобы `<EngineLoader>` рендерил один и тот же набор
 * сообщений независимо от того, каким путём загружался движок.
 */
export type WasmEngineErrorReason =
  | 'no_coi'
  | 'load_failed'
  | 'init_timeout'
  | 'worker_error';

export interface WasmEngineAdapterOptions {
  /**
   * KS-3170. Прогресс предзагрузки wasm (0..1). Вызывается во время
   * `fetch + ReadableStream` чтения lite-сборки. Если поток `total=0`
   * (CDN не вернул content-length) — колбэк может не вызываться вообще,
   * UI должен отрисовать «идёт загрузка» без процентов.
   */
  onProgress?: (loaded: number, total: number) => void;
  /**
   * KS-3170. Колбэк-причина при неудачной инициализации. Вызывается
   * ОДИН раз перед тем, как `init()` бросает Error — UI читает причину,
   * чтобы вывести `<EngineLoader>` с понятным текстом и retry.
   */
  onError?: (reason: WasmEngineErrorReason) => void;
}

/** KS-3170: 30 секунд — синхронизировано с useStockfish.INIT_TIMEOUT_MS. */
const WASM_INIT_TIMEOUT_MS = 30_000;

/**
 * KS-3170 (регрессия KS-3067): пользователь Realme снова получал
 * «Stockfish init timeout» в `/precision`. Корень — `PlayVsEngineRunner`
 * шёл через `WasmEngineAdapter`, минуя хук `useStockfish` (а KS-3067
 * чинил UI прогресса именно в хуке). Адаптер при этом загружал
 * `stockfish-18-single.js` → 113 МБ wasm, 15-секундный таймаут и ноль
 * визуальной обратной связи.
 *
 * Что изменилось:
 *  - Переключение на `stockfish-18-lite.js` (7 МБ wasm) — тот же файл,
 *    что грузит `useStockfish` после KS-3067.
 *  - Pre-fetch wasm через `fetch + ReadableStream` с прогрессом (`onProgress`).
 *    Worker создаётся только после успешной предзагрузки — wasm берётся
 *    из HTTP-кеша браузера (S3 отдаёт ETag/Last-Modified).
 *  - Гейт `crossOriginIsolated` — без SharedArrayBuffer lite-сборка не
 *    стартует, отдаём `no_coi` сразу, без 30-секундного ожидания.
 *  - Таймаут поднят до 30 с (как у `useStockfish`); 15 с не хватало
 *    мобильному CPU на uci-handshake + wasm compile даже при кешированном
 *    wasm.
 *  - `onError(reason)` для UI: `no_coi` / `load_failed` / `init_timeout`
 *    / `worker_error`.
 */
function isWasmMultiThreaded(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof crossOriginIsolated !== 'undefined' &&
    crossOriginIsolated
  );
}

async function fetchWasmWithProgress(
  url: string,
  signal: AbortSignal,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error(`fetch ${url} → HTTP ${response.status}`);
  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : 0;
  const reader = response.body?.getReader?.();
  if (!reader) {
    // Старая платформа без ReadableStream — читаем целиком, прогресс 0→100
    // только в самом конце.
    await response.arrayBuffer();
    onProgress?.(total || 1, total || 1);
    return;
  }
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      loaded += value.byteLength;
      onProgress?.(loaded, total || loaded);
    }
  }
  onProgress?.(total || loaded, total || loaded);
}

const ENGINE_JS_URL = '/stockfish/stockfish-18-lite.js';
const ENGINE_WASM_URL = '/stockfish/stockfish-18-lite.wasm';

export class WasmEngineAdapter implements EngineAdapter {
  private worker: Worker | null = null;
  private abortController: AbortController | null = null;
  private readonly onProgress?: (loaded: number, total: number) => void;
  private readonly onError?: (reason: WasmEngineErrorReason) => void;

  constructor(options: WasmEngineAdapterOptions = {}) {
    this.onProgress = options.onProgress;
    this.onError = options.onError;
  }

  async init(): Promise<void> {
    // KS-3170: гейт crossOriginIsolated. lite-сборка без COI не стартует,
    // single-fallback на S3 убран в KS-3067 — нет смысла 30 с крутить
    // таймаут, сразу отдаём понятную причину наверх.
    if (!isWasmMultiThreaded()) {
      this.onError?.('no_coi');
      throw new Error('Stockfish init failed: no_coi');
    }

    this.abortController = new AbortController();

    // 1) Предзагрузка wasm с прогрессом. На lite это ≈7 МБ, на 4G мобильном
    //    Realme ≈10–15 с — без прогресс-бара UX неотличим от зависания.
    try {
      await fetchWasmWithProgress(
        ENGINE_WASM_URL,
        this.abortController.signal,
        this.onProgress,
      );
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        // destroy() во время загрузки — нормальный путь, не сообщаем UI.
        throw err;
      }
      console.error('[WasmEngine] Failed to fetch wasm:', err);
      this.onError?.('load_failed');
      throw new Error('Stockfish init failed: load_failed');
    }

    // 2) Создаём worker — он внутри сам сделает fetch wasm и подхватит
    //    из HTTP-кеша браузера (S3 отдаёт ETag + Last-Modified).
    try {
      this.worker = new Worker(ENGINE_JS_URL);
    } catch (err) {
      console.error('[WasmEngine] Failed to create worker:', err);
      this.onError?.('worker_error');
      throw new Error('Stockfish init failed: worker_error');
    }

    // 3) UCI handshake с 30-секундным таймаутом (sync с useStockfish).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onError?.('init_timeout');
        this.worker?.removeEventListener('message', handler);
        reject(new Error('Stockfish init timeout'));
      }, WASM_INIT_TIMEOUT_MS);

      const errorHandler = (err: ErrorEvent) => {
        console.error('[WasmEngine] Worker error during init:', err);
        clearTimeout(timer);
        this.onError?.('worker_error');
        this.worker?.removeEventListener('message', handler);
        this.worker?.removeEventListener('error', errorHandler);
        reject(new Error('Stockfish init failed: worker_error'));
      };

      const handler = (e: MessageEvent) => {
        if (typeof e.data === 'string' && e.data.includes('uciok')) {
          clearTimeout(timer);
          this.worker!.removeEventListener('message', handler);
          this.worker!.removeEventListener('error', errorHandler);
          console.log('[WasmEngine] Stockfish ready');
          resolve();
        }
      };
      this.worker!.addEventListener('message', handler);
      this.worker!.addEventListener('error', errorHandler);
      this.worker!.postMessage('uci');
    });

    // KS-2525 / KS-2521: после uciok включаем UCI_ShowWDL — Stockfish
    // начинает добавлять `wdl W D L` в info-строки (W/D/L в промилле,
    // POV side-to-move). Парсер этого поля пишется в KS-2526. Опция
    // безопасна для старых сборок: если движок её не знает — он
    // отвечает «No such option», analyze продолжается без wdl.
    this.worker!.postMessage('setoption name UCI_ShowWDL value true');
  }

  setOption(name: string, value: string): void {
    this.worker?.postMessage(`setoption name ${name} value ${value}`);
  }

  analyze(
    fen: string,
    depth: number,
    multiPv: number,
    movetimeMs?: number,
    nodes?: number,
    searchmoves?: ReadonlyArray<string>,
  ): Promise<AnalysisResult> {
    return new Promise((resolve) => {
      const finalLines = new Map<number, InfoLine>();
      const bestByDepth = new Map<number, string>();
      const evalByDepth = new Map<number, number>();

      const handler = (e: MessageEvent) => {
        const msg = typeof e.data === 'string' ? e.data : '';

        if (msg.startsWith('info') && msg.includes(' pv ')) {
          const info = parseInfoLine(msg);
          if (info) {
            if (info.multipv === 1) {
              bestByDepth.set(info.depth, info.pv[0]);
              evalByDepth.set(info.depth, scoreToCP(info.score));
            }
            // KS-2955: раньше здесь стоял фильтр `info.depth >= depth - 2`
            // — он предполагал, что SF гарантированно доходит до целевой
            // глубины. С `movetime`/`nodes`/`searchmoves` SF может
            // остановиться раньше; храним последнюю info на каждый
            // multipv — она и есть финальная на момент остановки SF.
            finalLines.set(info.multipv, info);
          }
        }

        if (msg.startsWith('bestmove')) {
          this.worker!.removeEventListener('message', handler);
          resolve(buildResult(finalLines, bestByDepth, evalByDepth, depth));
        }
      };

      this.worker!.addEventListener('message', handler);
      this.worker!.postMessage(`setoption name MultiPV value ${multiPv}`);
      this.worker!.postMessage(`position fen ${fen}`);
      // KS-2955/KS-3364/KS-3380: собираем `go` команду из всех заданных
      // лимитов и фильтров. SF остановится по первому достигнутому из
      // (depth, movetime, nodes). `searchmoves` ограничивает корневые
      // ходы — используется для KS-3380 pre-frame WDL playedUci.
      const parts: string[] = [`go depth ${depth}`];
      if (nodes && nodes > 0) parts.push(`nodes ${Math.floor(nodes)}`);
      if (movetimeMs && movetimeMs > 0) parts.push(`movetime ${movetimeMs}`);
      if (searchmoves && searchmoves.length > 0) {
        parts.push(`searchmoves ${searchmoves.join(' ')}`);
      }
      this.worker!.postMessage(parts.join(' '));
    });
  }

  destroy(): void {
    // KS-3170: при destroy во время предзагрузки wasm — прервать fetch,
    // иначе он висит в очереди браузера и тратит трафик мобильного.
    if (this.abortController) {
      try { this.abortController.abort(); } catch { /* ignore */ }
      this.abortController = null;
    }
    this.worker?.terminate();
    this.worker = null;
  }
}

// ─── Bridge Adapter ───

export type BridgeConfig = {
  wsUrl: string;
  secretKey: string;
};

function normalizeWsUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === '/') url.pathname = '/ws';
    return url.toString();
  } catch {
    const base = raw.replace(/\/+$/, '');
    return base.endsWith('/ws') ? base : `${base}/ws`;
  }
}

function isLocalhostUrl(wsUrl: string): boolean {
  try {
    const url = new URL(wsUrl);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return wsUrl.includes('localhost') || wsUrl.includes('127.0.0.1');
  }
}

export class BridgeEngineAdapter implements EngineAdapter {
  private ws: WebSocket | null = null;
  private config: BridgeConfig;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    const baseUrl = normalizeWsUrl(this.config.wsUrl);
    const isLocal = isLocalhostUrl(this.config.wsUrl);
    const url = isLocal || !this.config.secretKey
      ? baseUrl
      : baseUrl.includes('?')
        ? `${baseUrl}&key=${encodeURIComponent(this.config.secretKey)}`
        : `${baseUrl}?key=${encodeURIComponent(this.config.secretKey)}`;

    console.log('[BridgeEngine] Connecting to:', url);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bridge connection timeout')), 10000);
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        clearTimeout(timer);
        reject(new Error('Failed to create WebSocket: ' + (err instanceof Error ? err.message : String(err))));
        return;
      }

      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        console.log('[BridgeEngine] Connected');
        // KS-2690: симметрично WasmEngineAdapter (KS-2521 / KS-2525) —
        // включаем UCI_ShowWDL сразу после connect, чтобы info-строки
        // содержали поле `wdl W D L`. Без этого клиентский генератор
        // пазлов (puzzleGenerator.ts) на алгоритме KS-2584 получает
        // `info.wdl=undefined`, `wdlSignedFromInfo` возвращает null и
        // все позиции отбраковываются → «Сгенерировано задач: 0».
        // Если конкретный движок за bridge не знает опцию, он
        // ответит «No such option» — analyze продолжается без wdl,
        // дополнительный warn делается в puzzleGenerator.
        this.setOption('UCI_ShowWDL', 'true');
        resolve();
      };

      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Bridge connection failed — is the bridge running?'));
      };

      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (!this.ws) {
          reject(new Error(`Bridge closed during connect (code ${ev.code})`));
        }
      };
    });
  }

  setOption(name: string, value: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'setoption', name, value }));
    }
  }

  analyze(
    fen: string,
    depth: number,
    multiPv: number,
    movetimeMs?: number,
    nodes?: number,
    searchmoves?: ReadonlyArray<string>,
  ): Promise<AnalysisResult> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Bridge not connected'));
        return;
      }

      const finalLines = new Map<number, InfoLine>();
      const bestByDepth = new Map<number, string>();
      const evalByDepth = new Map<number, number>();

      const handler = (e: MessageEvent) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.type === 'line') {
          // KS-2526: bridge может слать wdl как объект {w,d,l}; если
          // нет — оставляем undefined.
          const wdlRaw = msg.wdl as Record<string, unknown> | undefined;
          const wdl: WdlDistribution | undefined =
            wdlRaw &&
            typeof wdlRaw === 'object' &&
            typeof wdlRaw.w === 'number' &&
            typeof wdlRaw.d === 'number' &&
            typeof wdlRaw.l === 'number'
              ? { w: wdlRaw.w, d: wdlRaw.d, l: wdlRaw.l }
              : undefined;
          const info: InfoLine = {
            depth: Number(msg.depth ?? 0),
            multipv: Number(msg.multipv ?? 1),
            score: {
              type: (msg.score as Record<string, unknown>)?.type === 'mate' ? 'mate' : 'cp',
              value: Number((msg.score as Record<string, unknown>)?.value ?? 0),
            },
            pv: String(msg.pv ?? '').split(/\s+/).filter(Boolean),
            ...(wdl ? { wdl } : {}),
          };

          if (info.multipv === 1) {
            bestByDepth.set(info.depth, info.pv[0]);
            evalByDepth.set(info.depth, scoreToCP(info.score));
          }
          // KS-2955: см. WasmEngineAdapter — последняя info на multipv.
          finalLines.set(info.multipv, info);
        }

        if (msg.type === 'bestmove') {
          this.ws!.removeEventListener('message', handler);
          resolve(buildResult(finalLines, bestByDepth, evalByDepth, depth));
        }

        if (msg.type === 'error') {
          this.ws!.removeEventListener('message', handler);
          reject(new Error(String(msg.message ?? 'Bridge error')));
        }
      };

      this.ws.addEventListener('message', handler);
      // KS-2955/KS-3364/KS-3380: пробрасываем movetimeMs/nodes/searchmoves
      // в bridge. Legacy-серверы без поддержки игнорируют — остаётся
      // прежнее поведение по depth.
      this.ws.send(
        JSON.stringify({
          type: 'analyze',
          fen,
          depth,
          multiPv,
          ...(movetimeMs && movetimeMs > 0 ? { movetimeMs } : {}),
          ...(nodes && nodes > 0 ? { nodes: Math.floor(nodes) } : {}),
          ...(searchmoves && searchmoves.length > 0
            ? { searchmoves: [...searchmoves] }
            : {}),
        }),
      );
    });
  }

  destroy(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
