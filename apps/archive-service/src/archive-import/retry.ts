/**
 * KS-2156. Универсальный retry helper с экспоненциальной задержкой для
 * транзиентных ошибок Postgres / Prisma в archive-importer'е.
 *
 * Сценарии (см. KS-2155 анализ инцидента 29.04):
 *   - position-indexer.applyDeltas: $transaction в `position_stats`
 *     иногда возвращает Postgres `40P01` (deadlock_detected) под
 *     параллельной нагрузкой. Postgres ГАРАНТИРУЕТ transient семантику —
 *     один retry с минимальным backoff обычно решает.
 *   - twic.importer: `archiveGame.create` под перегрузкой RDS бьёт
 *     Prisma-ошибками `P1001` (Can't reach DB), `P1002` (timeout),
 *     `P2024` (pool timeout). Без retry-обёртки каждая транзиентная
 *     сетевая ошибка теряла партию (257 потерь за 24-часовое окно).
 *
 * Параметры по умолчанию:
 *   - max 5 попыток (ATTEMPT_DEFAULT);
 *   - initial delay 100 ms, factor 2, max delay 1500 ms — итого
 *     паузы 100, 200, 400, 800, 1500 (capped) — суммарно ≤ 3 s до
 *     полного отказа. Этого хватает чтобы переждать transient flap;
 *     дольше — уже не transient, нужно эскалировать.
 *
 * AbortSignal: если caller передаёт signal (например, потеря lock'а),
 * retry-loop прерывается между попытками и пробрасывает наверх
 * последнюю реальную ошибку. Это нужно чтобы потеря lock'а не
 * крутилась 3 секунды бесполезно — caller гасит импорт.
 */

const ATTEMPT_DEFAULT = 5;
const INITIAL_DELAY_DEFAULT_MS = 100;
const FACTOR_DEFAULT = 2;
const MAX_DELAY_DEFAULT_MS = 1_500;

export interface RetryOpts {
  /** Максимум попыток включая первую. Default 5. */
  maxAttempts?: number;
  /** Базовая задержка перед второй попыткой. Default 100 ms. */
  initialDelayMs?: number;
  /** Множитель backoff'а. Default 2 (100 → 200 → 400 → 800 → ...). */
  factor?: number;
  /** Верхний предел задержки между попытками. Default 1500 ms. */
  maxDelayMs?: number;
  /** Предикат: считать ли ошибку транзиентной и повторять. */
  isRetryable: (err: unknown) => boolean;
  /** Колбек для лога/метрик о ретрае. */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  /**
   * AbortSignal для досрочного выхода из retry-loop (например, при
   * потере lock'а). Если signal aborted ДО первой попытки — мы её
   * не делаем и сразу пробрасываем `signal.reason ?? new Error(...)`.
   * Если signal aborted в паузе между попытками — пробрасываем
   * последнюю реальную ошибку (а не abort), чтобы caller увидел
   * исходную причину.
   */
  signal?: AbortSignal;
  /** Подмена sleep для тестов. */
  sleep?: (ms: number) => Promise<void>;
}

export async function retryWithBackoff<T>(
  op: () => Promise<T>,
  opts: RetryOpts,
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? ATTEMPT_DEFAULT;
  const initialDelayMs = opts.initialDelayMs ?? INITIAL_DELAY_DEFAULT_MS;
  const factor = opts.factor ?? FACTOR_DEFAULT;
  const maxDelayMs = opts.maxDelayMs ?? MAX_DELAY_DEFAULT_MS;
  const sleepFn = opts.sleep ?? defaultSleep;

  // Если caller отменил ДО старта — сразу выйдем, не делаем даже первой
  // попытки. (Семантика стандартного AbortController в Node.)
  if (opts.signal?.aborted) {
    throw opts.signal.reason ?? new Error('aborted before first attempt');
  }

  let attempt = 0;
  let lastErr: unknown;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!opts.isRetryable(err) || attempt >= maxAttempts) {
        throw err;
      }
      const delayMs = Math.min(
        maxDelayMs,
        initialDelayMs * Math.pow(factor, attempt - 1),
      );
      opts.onRetry?.(attempt, delayMs, err);
      await sleepFn(delayMs);
      // Между попытками проверяем abort: caller гасит импорт.
      if (opts.signal?.aborted) {
        throw lastErr;
      }
    }
  }
  // unreachable — цикл бросит throw на последней попытке
  throw lastErr ?? new Error('retry exhausted');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Предикаты транзиентности ─────────────────────────────────────────

/**
 * Postgres `40P01` (deadlock_detected). Появляется и в нативном Prisma
 * `PrismaClientKnownRequestError` (code='P2034' с `meta.code='40P01'`),
 * и в raw `$executeRaw` ошибках pg-драйвера (`err.code === '40P01'`).
 * Проверяем оба варианта плюс fallback по message-substring.
 */
export function isPostgresDeadlock(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  if (e.code === '40P01') return true;
  if (e.code === 'P2034') return true; // Prisma transaction conflict — частный случай deadlock
  if (e.meta && e.meta.code === '40P01') return true;
  if (typeof e.message === 'string' && /deadlock_detected|40P01/i.test(e.message)) {
    return true;
  }
  return false;
}

/**
 * Prisma `P1001` (Can't reach database server), `P1002` (DB server
 * closed connection), `P2024` (pool timeout). Под нагрузкой эти три —
 * самые частые транзиентные ошибки на пути `archiveGame.create`.
 */
export function isPrismaTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'P1001' || code === 'P1002' || code === 'P2024';
}
