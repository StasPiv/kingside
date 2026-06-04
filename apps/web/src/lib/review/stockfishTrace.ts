/**
 * KS-3650 / ADR-107 rev 2 §6 F1. Web-обёртка над WASM-сборкой нашего
 * ответвления Stockfish 16 (`apps/web/public/stockfish/stockfish-16-trace.*`).
 *
 * Lazy-load: модуль подгружается только при первом вызове `evalTrace()`
 * — в обычной работе UI WASM весом ~476 КБ + pthread-worker не нужны.
 * При нажатии «Разобрать партию» оркестратор (`useGameReview`) делает
 * `evalTrace(fenAfter)` для каждого NAG-фокус хода.
 *
 * API модуля — стандартный emcc (см. `scripts/wasm-build/HANDOVER.md`):
 *   - `Module({ print, printErr, stdin, locateFile })` — фабрика;
 *   - `print(line)` — каждая stdout-строка от движка;
 *   - `stdin()` — callback, возвращает следующий код символа очередной
 *     UCI-команды, либо `null` (EOF, движок завершит main());
 *   - `locateFile(name)` — где искать `.wasm` / `.worker.js`.
 *
 * Семантика «один Module instance — один eval»:
 *   - подаём в очередь команд: `setoption name Use NNUE value false`,
 *     `position fen <X>`, `eval json`, `quit`;
 *   - после `quit` stdin исчерпан → SF завершает main() → инстанс
 *     одноразовый. Это просто и надёжно: текущая реализация emcc-SF
 *     без `Asyncify` не позволяет переиспользовать инстанс через
 *     синхронный stdin-callback без busy-wait.
 *
 * Graceful (см. acceptance):
 *   - WASM не загрузился (нет SAB / Worker / ошибка fetch) → `[]`;
 *   - тайм-аут ожидания JSON (5 с) → `[]`;
 *   - JSON не распарсился → `[]`;
 *   - неизвестные `id` в `subterms` → отбрасываются с WARN.
 *
 * KS-3675: emscripten-сборка `/stockfish/stockfish-16-trace.js` — это
 * UMD (`var StockfishTrace = …; module.exports = …; define([], …)`),
 * без ES-default. До этого фронт грузил её через динамический `import()`
 * — браузер отдавал пустой ES-объект, `mod.default ?? mod` оказывался
 * не функцией, в консоли писалось
 * `[stockfishTrace] module factory is not a function`, `positional_subterms`
 * везде оставались пустыми. Теперь файл подключаем через `<script>`-тег
 * и берём глобальный `window.StockfishTrace`.
 */
import type {
  PositionalSubterm,
  PositionalSubtermId,
} from '@kingside/shared';

const MODULE_URL = '/stockfish/stockfish-16-trace.js';
const EVAL_TIMEOUT_MS = 5000;
/**
 * KS-3677: тайм-аут на сам вызов `factory(...)`. Раньше его не было —
 * если исполнитель WASM не отвечает (нет SharedArrayBuffer, ошибка
 * инициализации), `await factory(...)` висел навсегда, а `EVAL_TIMEOUT_MS`
 * на ожидание JSON в этом случае не спасал.
 */
const FACTORY_TIMEOUT_MS = 8000;

/**
 * KS-3677: класс системной поломки исполнителя, который вызывающий
 * код должен показать пользователю (а не молча подставить `[]`).
 *
 * - `factory-timeout`: фабрика WASM не отвечает за `FACTORY_TIMEOUT_MS`.
 * - `factory-error`: фабрика выбросила исключение при init.
 * - `eval-timeout`: после init JSON не пришёл за `EVAL_TIMEOUT_MS`.
 */
export class StockfishTraceEngineError extends Error {
  constructor(
    public readonly reason:
      | 'factory-timeout'
      | 'factory-error'
      | 'eval-timeout',
    public readonly cause?: unknown,
  ) {
    super(`[stockfishTrace] engine error: ${reason}`);
    this.name = 'StockfishTraceEngineError';
  }
}

/**
 * Все валидные `PositionalSubtermId` — синхронизировано с union в
 * `packages/shared/src/types/api-contracts.ts` (KS-3649). Неизвестные id
 * (например, `psqt_*`, `mobility_*` — выходят из WASM, но не входят в
 * наш контракт MVP) отбрасываются с WARN на этапе парсинга. Если
 * архитектор расширит union — добавить сюда.
 */
const VALID_IDS: ReadonlySet<string> = new Set<PositionalSubtermId>([
  // Pawns.
  'pawn_doubled_early',
  'pawn_connected',
  'pawn_doubled',
  'pawn_isolated',
  'pawn_backward',
  'pawn_lever_double',
  'pawn_blocked',
  // Shelter & storm.
  'king_shelter_strength',
  'king_blocked_storm',
  'king_unblocked_storm',
  'king_on_file',
  // Pieces.
  'rook_on_king_ring',
  'bishop_on_king_ring',
  'knight_uncontested_outpost',
  'outpost_knight',
  'outpost_bishop',
  'knight_reachable_outpost',
  'minor_behind_pawn',
  'knight_king_protector_distance',
  'bishop_king_protector_distance',
  'bishop_pawns',
  'bishop_xray_pawns',
  'bishop_long_diagonal',
  'bishop_cornered',
  'rook_on_open_file',
  'rook_on_closed_file',
  'rook_trapped',
  'queen_weak',
  // King.
  'king_safety_pawn',
  'king_danger',
  'king_safe_check_rook',
  'king_safe_check_queen',
  'king_safe_check_bishop',
  'king_safe_check_knight',
  'king_pawnless_flank',
  'king_flank_attacks',
  // Threats.
  'threat_by_minor',
  'threat_by_rook',
  'threat_by_king',
  'threat_hanging',
  'threat_weak_queen_protection',
  'threat_restricted_piece',
  'threat_by_safe_pawn',
  'threat_by_pawn_push',
  'threat_knight_on_queen',
  'threat_slider_on_queen',
  // Passed.
  'passed_rank',
  'passed_king_proximity',
  'passed_path_advance',
  'passed_file_edge',
  // Space.
  'space',
]);

interface RawSubtermJson {
  id?: unknown;
  square?: unknown;
  color?: unknown;
  value_mg?: unknown;
  value_eg?: unknown;
}

interface RawTraceJson {
  position?: { fen?: string; sideToMove?: 'w' | 'b' };
  subterms?: RawSubtermJson[];
  total?: { mg?: number; eg?: number; v?: number };
}

/**
 * Чистая функция парсинга raw-JSON от UCI `eval json` в типизированный
 * массив `PositionalSubterm[]`. Используется и в `evalTrace`, и в тестах
 * на сверку с baseline (без поднятия WASM).
 *
 * Поведение:
 *   - `null` / не-объект / нет `subterms` → `[]`;
 *   - неизвестные `id` (нет в `VALID_IDS`) → пропускаются + WARN через
 *     `onUnknown`;
 *   - невалидные числа (`value_mg`/`value_eg`) → элемент пропускается;
 *   - `square` валидируется регуляркой `[a-h][1-8]`; иначе — отсутствует;
 *   - `color` — только `'w'`/`'b'`; иначе — отсутствует.
 */
export function parseTraceJson(
  raw: unknown,
  onUnknown?: (id: string) => void,
): PositionalSubterm[] {
  if (!raw || typeof raw !== 'object') return [];
  const j = raw as RawTraceJson;
  if (!Array.isArray(j.subterms)) return [];
  const out: PositionalSubterm[] = [];
  for (const s of j.subterms) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.id !== 'string') continue;
    if (typeof s.value_mg !== 'number' || !Number.isFinite(s.value_mg)) continue;
    if (typeof s.value_eg !== 'number' || !Number.isFinite(s.value_eg)) continue;
    if (!VALID_IDS.has(s.id)) {
      onUnknown?.(s.id);
      continue;
    }
    const term: PositionalSubterm = {
      id: s.id as PositionalSubtermId,
      value_mg: s.value_mg,
      value_eg: s.value_eg,
    };
    if (s.color === 'w' || s.color === 'b') term.color = s.color;
    if (typeof s.square === 'string' && /^[a-h][1-8]$/.test(s.square)) {
      term.square = s.square;
    }
    out.push(term);
  }
  return out;
}

// --- module-factory loader (lazy, cached) ---------------------------------

type ModuleOptions = {
  print: (line: string) => void;
  printErr?: (line: string) => void;
  stdin: () => number | null;
  locateFile?: (name: string) => string;
};

type ModuleFactory = (options: ModuleOptions) => Promise<unknown>;

let cachedFactory: ModuleFactory | null = null;
let factoryPromise: Promise<ModuleFactory | null> | null = null;

/** Имя глобала, в который emscripten кладёт UMD-фабрику. */
const GLOBAL_NAME = 'StockfishTrace';

/**
 * Загружает UMD-фабрику единожды. Повторные вызовы возвращают тот же
 * promise. Любая ошибка загрузки → `null` (graceful — caller вернёт `[]`).
 *
 * KS-3675: подключаем через `<script>` и читаем `window.StockfishTrace`.
 * Динамический `import()` не подходит — модуль не ES, у него нет
 * `default`-экспорта, в браузере он отдаёт пустой объект.
 *
 * В SSR/jsdom-окружении (где нет `document` / `window`) — мгновенно `null`,
 * чтобы тесты не падали с ReferenceError.
 */
async function _loadFactoryLegacy(): Promise<ModuleFactory | null> {
  if (cachedFactory) return cachedFactory;
  if (factoryPromise) return factoryPromise;
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }
  factoryPromise = new Promise<ModuleFactory | null>((resolve) => {
    const win = window as unknown as Record<string, unknown>;
    const existing = win[GLOBAL_NAME];
    if (typeof existing === 'function') {
      cachedFactory = existing as ModuleFactory;
      resolve(cachedFactory);
      return;
    }
    const s = document.createElement('script');
    s.src = MODULE_URL;
    s.async = true;
    s.onload = () => {
      const f = win[GLOBAL_NAME];
      if (typeof f !== 'function') {
        console.warn('[stockfishTrace] module factory is not a function');
        factoryPromise = null;
        resolve(null);
        return;
      }
      cachedFactory = f as ModuleFactory;
      resolve(cachedFactory);
    };
    s.onerror = (err) => {
      console.warn('[stockfishTrace] failed to load WASM module:', err);
      factoryPromise = null;
      resolve(null);
    };
    document.head.appendChild(s);
  });
  return factoryPromise;
}

/**
 * Тест-хук: сбросить кэш загрузчика. Используется в `stockfishTrace.test.ts`,
 * чтобы между кейсами не утекала singleton-фабрика.
 */
export function _resetStockfishTraceCacheForTests(): void {
  cachedFactory = null;
  factoryPromise = null;
  if (cachedWorker) {
    try {
      cachedWorker.terminate();
    } catch {
      /* ignore */
    }
    cachedWorker = null;
  }
}

// --- worker-based path (KS-3680) -----------------------------------------

/**
 * KS-3680. Один общий Worker на жизненный цикл вкладки. Раньше для
 * `stockfish-16-trace.js` я грузил скрипт в основной поток и вызывал
 * `factory(...)` синхронно — emscripten внутри блокировал поток на
 * инициализации, `setTimeout`-таймауты не срабатывали, разбор висел
 * после баннера «Stockfish 16…».
 *
 * Запуск через `new Worker(url)` переносит ВСЁ выполнение исполнителя
 * в отдельный поток. Основной поток жив, таймеры работают, при
 * зависании можно `worker.terminate()`. Этот путь — копия подхода из
 * `PositionalEvalEngine` (stockfish-16-lite), который уже работает.
 */
let cachedWorker: Worker | null = null;
let cachedWorkerReady: Promise<Worker> | null = null;

const INIT_TIMEOUT_MS = 8000;
const NO_WORKER_SENTINEL = Symbol('no-worker');

async function getWorker(): Promise<Worker> {
  if (cachedWorker) return cachedWorker;
  if (cachedWorkerReady) return cachedWorkerReady;
  if (typeof Worker === 'undefined') {
    // KS-3680. Нет Worker'ов (SSR / jsdom) → возвращаем sentinel.
    // Вызывающий код в `evalTraceViaWorker` поймает null и вернёт []
    // вместо ошибки. Бросать здесь — значит ломать прежнее поведение
    // тестов KS-3616 useGameReview, которые не подключают Worker.
    throw NO_WORKER_SENTINEL;
  }
  cachedWorkerReady = new Promise<Worker>((resolve, reject) => {
    let w: Worker;
    try {
      w = new Worker(MODULE_URL);
    } catch (err) {
      cachedWorkerReady = null;
      reject(new StockfishTraceEngineError('factory-error', err));
      return;
    }
    const initStart = performance.now();
    const timer = setTimeout(() => {
      console.warn(
        `[stockfishTrace] worker init timeout (${INIT_TIMEOUT_MS}ms exceeded)`,
      );
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      try {
        w.terminate();
      } catch {
        /* ignore */
      }
      cachedWorkerReady = null;
      reject(new StockfishTraceEngineError('factory-timeout'));
    }, INIT_TIMEOUT_MS);

    const onMessage = (e: MessageEvent) => {
      const data = typeof e.data === 'string' ? e.data : '';
      if (data && data.length < 200) {
        console.info('[stockfishTrace] ←', data);
      }
      if (data === 'uciok') {
        w.postMessage('setoption name Use NNUE value false');
        w.postMessage('isready');
      } else if (data === 'readyok') {
        clearTimeout(timer);
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        cachedWorker = w;
        cachedWorkerReady = null;
        console.info(
          `[stockfishTrace] worker ready in ${Math.round(performance.now() - initStart)}ms`,
        );
        resolve(w);
      }
    };
    const onError = (err: ErrorEvent) => {
      clearTimeout(timer);
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      try {
        w.terminate();
      } catch {
        /* ignore */
      }
      cachedWorkerReady = null;
      console.warn('[stockfishTrace] worker error:', err.message);
      reject(new StockfishTraceEngineError('factory-error', err));
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.postMessage('uci');
  });
  return cachedWorkerReady;
}

// --- evalTrace: one-shot per FEN -----------------------------------------

/**
 * Поднимает Module-instance, посылает UCI `eval json` по FEN, ждёт
 * stdout-JSON, парсит, возвращает массив подкомпонент. На любой
 * ошибке — `[]` (WARN в console).
 *
 * Тайм-аут (5 c) от первой команды до полного JSON в stdout.
 *
 * Параметр `factory` — для тестов (мок без реального WASM).
 */
export async function evalTrace(
  fen: string,
  options: { factory?: ModuleFactory } = {},
): Promise<PositionalSubterm[]> {
  // KS-3680: основной путь — через Worker. Если в опциях передана
  // factory (тесты) — идём старым путём с print/stdin (он не блокирует
  // основной поток в тестах, у которых фабрика — обычная async-функция).
  if (!options.factory) {
    return evalTraceViaWorker(fen);
  }
  const factory = options.factory;

  // Очередь UCI-команд. `quit` после `eval json` — чтобы main() корректно
  // завершилась после ответа (см. описание выше про одноразовый instance).
  const commands = [
    'setoption name Use NNUE value false',
    `position fen ${fen}`,
    'eval json',
    'quit',
  ];
  let cmdIdx = 0;
  let charIdx = 0;
  let currentBuf = commands[0] + '\n';

  // Сборка многострочного JSON из stdout. Начинаем собирать с первой
  // строки, начинающейся на `{`, заканчиваем когда braceDepth → 0.
  let collecting = false;
  let braceDepth = 0;
  const buf: string[] = [];
  let resolveJson: (j: unknown) => void = () => {};
  const jsonPromise = new Promise<unknown>((r) => {
    resolveJson = r;
  });

  const stdin = (): number | null => {
    if (charIdx >= currentBuf.length) {
      cmdIdx++;
      if (cmdIdx >= commands.length) return null;
      currentBuf = commands[cmdIdx] + '\n';
      charIdx = 0;
    }
    return currentBuf.charCodeAt(charIdx++);
  };

  const print = (line: string) => {
    if (!collecting) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('{')) {
        collecting = true;
        buf.length = 0;
        braceDepth = 0;
      } else {
        return;
      }
    }
    buf.push(line);
    for (let i = 0; i < line.length; i++) {
      const ch = line.charCodeAt(i);
      if (ch === 0x7b /* { */) braceDepth++;
      else if (ch === 0x7d /* } */) braceDepth--;
    }
    if (collecting && braceDepth <= 0 && buf.length > 0) {
      collecting = false;
      try {
        resolveJson(JSON.parse(buf.join('\n')));
      } catch {
        resolveJson(null);
      }
    }
  };

  // KS-3677: оборачиваем factory() в таймаут. Без него ожидание
  // инициализации WASM может длиться неограниченно долго (типичная
  // причина — нет SharedArrayBuffer в окружении исполнителя).
  let factoryTimer: ReturnType<typeof setTimeout> | null = null;
  const factoryStartedAt = performance.now();
  try {
    await Promise.race([
      factory({
        print,
        printErr: () => {},
        stdin,
        locateFile: (name: string) => `/stockfish/${name}`,
      }),
      new Promise((_, reject) => {
        factoryTimer = setTimeout(() => {
          reject(new StockfishTraceEngineError('factory-timeout'));
        }, FACTORY_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    if (err instanceof StockfishTraceEngineError) {
      console.warn(
        `[stockfishTrace] factory timeout (${FACTORY_TIMEOUT_MS}ms exceeded)`,
      );
      throw err;
    }
    console.warn('[stockfishTrace] WASM init failed:', err);
    throw new StockfishTraceEngineError('factory-error', err);
  } finally {
    if (factoryTimer) clearTimeout(factoryTimer);
  }
  console.info(
    `[stockfishTrace] factory ready in ${Math.round(performance.now() - factoryStartedAt)}ms`,
  );

  const raw = await Promise.race([
    jsonPromise,
    new Promise<unknown>((r) => setTimeout(() => r(null), EVAL_TIMEOUT_MS)),
  ]);
  if (raw == null) {
    console.warn('[stockfishTrace] eval timeout / no JSON in stdout');
    throw new StockfishTraceEngineError('eval-timeout');
  }
  return parseTraceJson(raw, (id) =>
    console.warn(`[stockfishTrace] unknown subterm id (skipped): ${id}`),
  );
}

/**
 * KS-3680. Основной путь evalTrace — через переиспользуемый Worker.
 * Один раз поднимаем Worker (init: `uci` → `uciok` → `setoption NNUE
 * off` → `isready` → `readyok`), дальше на каждый FEN шлём
 * `position fen … / eval json`, собираем JSON из stdout, парсим.
 */
async function evalTraceViaWorker(fen: string): Promise<PositionalSubterm[]> {
  let w: Worker;
  try {
    w = await getWorker();
  } catch (e) {
    // KS-3680. Нет Worker (SSR / jsdom) — graceful [] для тестов.
    // Реальные системные ошибки (timeout / error) поднимаются выше.
    if (e === NO_WORKER_SENTINEL) return [];
    throw e;
  }

  // Сборка JSON из приходящих stdout-строк.
  let collecting = false;
  let braceDepth = 0;
  const buf: string[] = [];
  let resolveJson: (j: unknown) => void = () => {};
  const jsonPromise = new Promise<unknown>((r) => {
    resolveJson = r;
  });

  const onMessage = (e: MessageEvent) => {
    const line = typeof e.data === 'string' ? e.data : '';
    if (!collecting) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('{')) {
        collecting = true;
        buf.length = 0;
        braceDepth = 0;
      } else {
        return;
      }
    }
    buf.push(line);
    for (let i = 0; i < line.length; i++) {
      const ch = line.charCodeAt(i);
      if (ch === 0x7b) braceDepth++;
      else if (ch === 0x7d) braceDepth--;
    }
    if (collecting && braceDepth <= 0 && buf.length > 0) {
      collecting = false;
      try {
        resolveJson(JSON.parse(buf.join('\n')));
      } catch {
        resolveJson(null);
      }
    }
  };
  w.addEventListener('message', onMessage);
  w.postMessage(`position fen ${fen}`);
  w.postMessage('eval json');

  let evalTimer: ReturnType<typeof setTimeout> | null = null;
  const raw = await Promise.race([
    jsonPromise,
    new Promise<unknown>((r) => {
      evalTimer = setTimeout(() => r(null), EVAL_TIMEOUT_MS);
    }),
  ]);
  if (evalTimer) clearTimeout(evalTimer);
  w.removeEventListener('message', onMessage);

  if (raw == null) {
    console.warn(
      `[stockfishTrace] eval timeout (${EVAL_TIMEOUT_MS}ms) — terminating worker`,
    );
    try {
      w.terminate();
    } catch {
      /* ignore */
    }
    cachedWorker = null;
    throw new StockfishTraceEngineError('eval-timeout');
  }
  return parseTraceJson(raw, (id) =>
    console.warn(`[stockfishTrace] unknown subterm id (skipped): ${id}`),
  );
}
