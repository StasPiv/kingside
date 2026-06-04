/**
 * KS-3628 / ADR-103 rev 3 §6.3 — клиентский Stockfish 16 lite
 * (classical evaluator, NNUE off) для получения breakdown 13 терминов.
 *
 * Web Worker создаётся lazy по первому `evalPosition()`. Один процесс
 * на жизненный цикл — переиспользуется для всех ходов прогона разбора.
 * `destroy()` отпускает воркер (вызывается при unmount страницы разбора).
 *
 * Graceful: при init-таймауте / парс-ошибке вызывающий код получает
 * `null` и пишет `positional_shifts: []`. Разбор партии не блокируется.
 */
import type {
  ClassicalEvalBreakdown,
  ClassicalEvalTerm,
  TermBreakdown,
  TermPair,
} from './positionalShifts';

const ENGINE_JS_URL = '/stockfish/stockfish-16-lite.js';
// KS-3678: было 30 секунд, что слишком много для UX — если исполнитель
// действительно сломан, пользователь почти полминуты ждёт перед
// ошибкой. Сокращаем до 12 секунд: на исправном WASM init обычно
// 1–3 секунды, 12 с — с запасом.
const INIT_TIMEOUT_MS = 12_000;
const DEFAULT_EVAL_TIMEOUT_MS = 500;

/** Возможные причины фатальной ошибки voida. Для логов и telemetry. */
export type PositionalEvalErrorReason =
  | 'no_worker_global'
  | 'worker_error'
  | 'init_timeout'
  | 'eval_timeout';

export interface PositionalEvalOptions {
  /** Таймаут на одну `evalPosition` (мс). По умолчанию 500. */
  evalTimeoutMs?: number;
  /** Кастомный URL загрузчика — для тестов и custom-deploy. */
  engineJsUrl?: string;
  onError?: (reason: PositionalEvalErrorReason, err?: unknown) => void;
}

/** Маппинг строки заголовка таблицы (regexp) → ключ ClassicalEvalTerm. */
const TERM_ROW_PATTERNS: Array<{
  regex: RegExp;
  key: ClassicalEvalTerm;
}> = [
  { regex: /^\|\s*Material\s*\|/i, key: 'material' },
  { regex: /^\|\s*Imbalance\s*\|/i, key: 'imbalance' },
  { regex: /^\|\s*Pawns\s*\|/i, key: 'pawns' },
  { regex: /^\|\s*Knights\s*\|/i, key: 'knights' },
  { regex: /^\|\s*Bishops\s*\|/i, key: 'bishops' },
  { regex: /^\|\s*Rooks\s*\|/i, key: 'rooks' },
  { regex: /^\|\s*Queens\s*\|/i, key: 'queens' },
  { regex: /^\|\s*Mobility\s*\|/i, key: 'mobility' },
  { regex: /^\|\s*King\s*safety\s*\|/i, key: 'king_safety' },
  { regex: /^\|\s*Threats\s*\|/i, key: 'threats' },
  { regex: /^\|\s*Passed\s*\|/i, key: 'passed' },
  { regex: /^\|\s*Space\s*\|/i, key: 'space' },
  { regex: /^\|\s*Winnable\s*\|/i, key: 'winnable' },
];

function parsePair(raw: string): TermPair | null {
  // raw — содержимое одной ячейки, два числа MG EG (или ----  ----).
  if (raw.includes('----')) return null;
  const nums = raw.trim().split(/\s+/);
  if (nums.length < 2) return null;
  const mg = Number(nums[0]);
  const eg = Number(nums[1]);
  if (!Number.isFinite(mg) || !Number.isFinite(eg)) return null;
  return { mg, eg };
}

/**
 * Парсер строки вида `|   Material |  ---- ----  |  ---- ----  |  0.00 0.00  |`.
 * Возвращает breakdown по 4 ячейкам: term-name, white, black, total.
 */
function parseTermRow(line: string): TermBreakdown | null {
  // Делим по `|`, после удаляем пустые края.
  const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
  // cells[0] = name, cells[1] = white, cells[2] = black, cells[3] = total.
  if (cells.length < 4) return null;
  const white = parsePair(cells[1]);
  const black = parsePair(cells[2]);
  const total = parsePair(cells[3]);
  if (!white || !black) {
    // Material/Imbalance/Total строки выводят `----  ----` в white/black
    // полях, но в total — числа. Поддержим этот случай: заполним
    // нулями, чтобы дальше readTermValue использовал total.
    return {
      white: white ?? { mg: 0, eg: 0 },
      black: black ?? { mg: 0, eg: 0 },
      total,
    };
  }
  return { white, black, total };
}

const FINAL_EVAL_REGEX =
  /(?:Final|Classical) evaluation\s+([+-]?\d+\.\d+)/i;

/**
 * Pure-функция: разбор полного вывода `eval` (все строки от первого
 * `Contributing terms` до `Final evaluation`).
 *
 * Возвращает null если таблица неполная или нечитаемая.
 */
export function parseClassicalEvalOutput(
  lines: string[],
): ClassicalEvalBreakdown | null {
  const terms = {} as Record<ClassicalEvalTerm, TermBreakdown>;
  let final: number | null = null;
  let inTable = false;

  for (const line of lines) {
    if (!inTable) {
      if (/Contributing terms/i.test(line)) inTable = true;
      continue;
    }
    // Внутри таблицы: пробуем каждый pattern.
    for (const { regex, key } of TERM_ROW_PATTERNS) {
      if (regex.test(line)) {
        const bd = parseTermRow(line);
        if (bd) terms[key] = bd;
        break;
      }
    }
    const m = line.match(FINAL_EVAL_REGEX);
    if (m) {
      final = Number(m[1]);
      // продолжаем — может быть несколько строк, последняя побеждает.
    }
  }

  // Проверяем что собрали все 13 терминов.
  const required: ClassicalEvalTerm[] = [
    'material',
    'imbalance',
    'pawns',
    'knights',
    'bishops',
    'rooks',
    'queens',
    'mobility',
    'king_safety',
    'threats',
    'passed',
    'space',
    'winnable',
  ];
  for (const r of required) {
    if (!terms[r]) return null;
  }
  return { terms, final };
}

/** Создание Worker — выделено в фабрику, чтобы можно было замокать в тестах. */
export type WorkerFactory = (url: string) => Worker;

const defaultWorkerFactory: WorkerFactory = (url) => new Worker(url);

/**
 * Главный класс. Использование:
 *   const engine = new PositionalEvalEngine({ onError });
 *   await engine.init();
 *   const bd = await engine.evalPosition(fen);
 *   engine.destroy();
 */
export class PositionalEvalEngine {
  private worker: Worker | null = null;
  private readonly evalTimeoutMs: number;
  private readonly engineJsUrl: string;
  private readonly onError?: PositionalEvalOptions['onError'];
  private readonly factory: WorkerFactory;
  private readonly factoryIsCustom: boolean;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(
    options: PositionalEvalOptions = {},
    factory?: WorkerFactory,
  ) {
    this.evalTimeoutMs = options.evalTimeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
    this.engineJsUrl = options.engineJsUrl ?? ENGINE_JS_URL;
    this.onError = options.onError;
    this.factory = factory ?? defaultWorkerFactory;
    this.factoryIsCustom = factory != null;
  }

  async init(): Promise<void> {
    // Проверка global Worker — только если используем дефолтную фабрику.
    // Кастомная фабрика (тесты) сама знает, как создать Worker-like.
    if (!this.factoryIsCustom && typeof Worker === 'undefined') {
      this.onError?.('no_worker_global');
      throw new Error('PositionalEval init: Worker is not available');
    }
    try {
      this.worker = this.factory(this.engineJsUrl);
    } catch (err) {
      this.onError?.('worker_error', err);
      throw err;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onError?.('init_timeout');
        this.worker?.removeEventListener('message', handler);
        reject(new Error('PositionalEval init timeout'));
      }, INIT_TIMEOUT_MS);

      const errorHandler = (err: ErrorEvent) => {
        clearTimeout(timer);
        this.onError?.('worker_error', err);
        this.worker?.removeEventListener('message', handler);
        this.worker?.removeEventListener('error', errorHandler);
        reject(new Error('PositionalEval worker error'));
      };

      // KS-3678: логи входящих сообщений на этапе init. Если приходит
      // баннер «Stockfish 16 by the Stockfish developers», но дальше
      // не приходит `uciok` — это будет видно в консоли и можно
      // отличить «исполнитель не стартовал» от «UCI-протокол не
      // отвечает». Без этих логов причина зависания была неотличима.
      const handler = (e: MessageEvent) => {
        const data = typeof e.data === 'string' ? e.data : '';
        if (data && data.length < 200) {
          // Длинные строки (например, debug-вывод) не логируем — спам.
          console.info('[positionalEval] ←', data);
        }
        if (data === 'uciok') {
          // Включаем classical: NNUE off.
          this.worker?.postMessage('setoption name Use NNUE value false');
          this.worker?.postMessage('isready');
        } else if (data === 'readyok') {
          clearTimeout(timer);
          this.worker?.removeEventListener('message', handler);
          this.worker?.removeEventListener('error', errorHandler);
          resolve();
        }
      };

      this.worker!.addEventListener('message', handler);
      this.worker!.addEventListener('error', errorHandler);
      this.worker!.postMessage('uci');
    });
  }

  /**
   * Эвал одной FEN-позиции. Сериализованно (одна команда `eval` в любой
   * момент времени) — Stockfish single-worker не любит конкурентных
   * запросов в режиме eval.
   */
  evalPosition(fen: string): Promise<ClassicalEvalBreakdown | null> {
    const run = async (): Promise<ClassicalEvalBreakdown | null> => {
      if (!this.worker) {
        this.onError?.('worker_error');
        return null;
      }
      const worker = this.worker;
      return new Promise<ClassicalEvalBreakdown | null>((resolve) => {
        const lines: string[] = [];
        const timer = setTimeout(() => {
          this.onError?.('eval_timeout');
          worker.removeEventListener('message', handler);
          resolve(null);
        }, this.evalTimeoutMs);
        const handler = (e: MessageEvent) => {
          const data = typeof e.data === 'string' ? e.data : '';
          lines.push(data);
          if (FINAL_EVAL_REGEX.test(data)) {
            clearTimeout(timer);
            worker.removeEventListener('message', handler);
            resolve(parseClassicalEvalOutput(lines));
          }
        };
        worker.addEventListener('message', handler);
        worker.postMessage(`position fen ${fen}`);
        worker.postMessage('eval');
      });
    };

    // Сериализация очереди.
    const next = this.busy.then(() => run());
    this.busy = next.catch(() => undefined);
    return next;
  }

  destroy(): void {
    try {
      this.worker?.postMessage('quit');
    } catch {
      // ignore
    }
    try {
      this.worker?.terminate();
    } catch {
      // ignore
    }
    this.worker = null;
  }
}
