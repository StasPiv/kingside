/**
 * Распределённый Redis-lock с коротким TTL и heartbeat'ом для
 * archive-importer'а (KS-1898).
 *
 * Зачем переписали:
 *   До этой задачи `archive:import:lock:twic` (и аналогичные) ставился
 *   с длинным TTL — 30 минут. Cleanup полагался на NestJS
 *   `OnModuleDestroy` или явный try/finally в сервисе. Проблема: ECS
 *   `stop-task` посылает SIGTERM с grace period ~30 сек, потом SIGKILL.
 *   Если Nest не успевает завершиться (а он часто не успевает —
 *   параллельный close десятка модулей), lock остаётся «висеть» 30 мин.
 *   Видели дважды в KS-1893: 1ч 24мин потерь на ожидание.
 *
 * Новая стратегия:
 *   1. **Короткий TTL** (60 сек по умолчанию). После SIGKILL Redis сам
 *      выпустит ключ ≤60 сек.
 *   2. **Heartbeat**: пока процесс жив, `setInterval` каждые 30 сек
 *      продлевает TTL Lua-скриптом
 *      `if GET==token then PEXPIRE`. Для холдера TTL никогда не падает
 *      ниже ~30 сек.
 *   3. **UUID-токен в значении lock'а** + **release-script**
 *      `if GET==token then DEL`. Защищает от race: если наш TTL истёк
 *      и ключ перехватил другой процесс, наш `release()` НЕ снимет
 *      чужой lock.
 *   4. `OnModuleDestroy` остаётся как fast path для нормального
 *      shutdown'а, но больше не критичен для корректности.
 *
 * Lock-value формат: `<token>:<role>:<issue|->:<pid>`.
 *   - `token` (UUID v4) — единственное, что сравнивается Lua-скриптом
 *     (full string, GET == ARGV[1] — поэтому весь value целиком, но
 *     токен делает его уникальным).
 *   - `role` ∈ `'scheduler' | 'adhoc' | 'backfill'` — для логов и
 *     duplicate-self detection в KS-1896.
 *   - `issue` — номер TWIC issue (только для adhoc/backfill).
 *   - `pid` — для оператора чтобы ssh'нуть и посмотреть процесс.
 *
 * Helper не зависит от NestJS — это just IO+timing-модуль. Тесты
 * подсовывают fake Redis и fake setInterval/clearInterval, прогон
 * <50ms.
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { Logger } from '@nestjs/common';

/**
 * Lua-скрипт релиза. Выполняется атомарно. Возвращает 1, если ключ
 * был наш и удалён, 0 — если в ключе чужой токен (или ключ уже
 * истёк). Caller интерпретирует 0 как «не наш — не трогаем».
 */
export const RELEASE_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`.trim();

/**
 * Lua-скрипт продления TTL. Атомарно проверяет, что ключ всё ещё
 * наш (GET == token), и обновляет TTL до `PEXPIRE ms`. Возвращает
 * 1 при успехе, 0 если токен уже не совпадает (нас уже сняли — и
 * heartbeat продолжать смысла нет, caller остановит interval по
 * первому false).
 */
export const EXTEND_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`.trim();

export type LockRole = 'scheduler' | 'adhoc' | 'backfill';

export type AcquireLockRedis = Pick<Redis, 'set' | 'get' | 'eval'>;

export interface AcquireLockOpts {
  redis: AcquireLockRedis;
  /** Полный ключ в Redis. Например `archive:import:lock:twic`. */
  key: string;
  role: LockRole;
  /** Номер выпуска (для adhoc/backfill). Для scheduler — undefined. */
  issue?: number;
  /** PID процесса. Default — `process.pid`. */
  pid?: number;
  /** TTL ключа в Redis. Default 600_000 ms (10 мин, KS-2157). */
  ttlMs?: number;
  /** Период heartbeat'а. Default ttl/2 (300_000 ms при ttl=600_000). */
  heartbeatMs?: number;
  /**
   * Если true, heartbeat не запускается. Полезно для коротких
   * операций (ad-hoc CLI, который не ожидает работать дольше TTL)
   * или для тестов, не желающих возиться с timer'ами.
   */
  disableHeartbeat?: boolean;
  logger?: Pick<Logger, 'log' | 'warn'>;
  // ─── hooks для тестов ─────────────────────────────────────────
  /** Подменить `randomUUID()`; default — `node:crypto.randomUUID`. */
  randomUUID?: () => string;
  /** Подменить `setInterval`; default — global. */
  setInterval?: (cb: () => void, ms: number) => unknown;
  /** Подменить `clearInterval`; default — global. */
  clearInterval?: (handle: unknown) => void;
}

export interface AcquiredLock {
  /** Уникальный UUID-токен. Для логов/дебага. */
  readonly token: string;
  /** Полное значение в Redis: `<token>:<role>:<issue|->:<pid>`. */
  readonly value: string;
  /** Период heartbeat'а, реально применённый (после env override'ов). */
  readonly heartbeatMs: number;
  /** TTL, реально применённый. */
  readonly ttlMs: number;
  /**
   * KS-2156. AbortSignal, который срабатывает при потере lock'а:
   *   - heartbeat вернул mismatch (`if GET==token then PEXPIRE` → 0);
   *   - heartbeat бросил исключение (Redis отвалился);
   *   - истёк TTL без успешного heartbeat'а.
   *
   * Caller'ы (TwicImporter, position-indexer) подписываются на signal
   * и **останавливают активный импорт** — раньше `WARN heartbeat stopped`
   * писался, но импорт продолжал держать БД и параллельно его уже
   * шёл другой процесс (4+ параллельных токена в инциденте 29.04).
   *
   * Сам `release()` НЕ вызывает abort — это нормальное завершение,
   * caller уже выходит из импорта по своей логике.
   *
   * `signal.reason` — `Error('lock lost: <причина>')`.
   */
  readonly signal: AbortSignal;
  /**
   * Освобождает lock через Lua (`if GET==value then DEL`).
   * Идемпотентен (повторный вызов — no-op). Останавливает heartbeat
   * перед DEL. Возвращает `true`, если ключ был нашим и удалён;
   * `false` — если уже истёк или перехвачен другим процессом
   * (расценивается как «не наша забота, гасим heartbeat и идём
   * дальше»).
   */
  release(): Promise<boolean>;
}

/**
 * Конфигурация lock'а из env (`ARCHIVE_IMPORTER_LOCK_TTL_MS`,
 * `ARCHIVE_IMPORTER_LOCK_HEARTBEAT_MS`). Не хардкодим в helper'е,
 * чтобы prod мог поднять/опустить значения без пересборки.
 *
 * Дефолты:
 *   - `ttlMs`       = 600_000 (10 мин)
 *   - `heartbeatMs` = ttl/2 (по умолчанию 5 мин, clamp ≥ 1 с)
 *
 * KS-2157 (post-mortem 30.04, adhoc 1592, devops):
 *   parseBatch для TWIC-zip 7000+ партий блокирует Node event loop
 *   ~1м53с (CPU-bound, синхронный pgn-parser). Прежний дефолт TTL=60s
 *   успевал истечь до того, как `setInterval(...)`-heartbeat смог
 *   физически tick'нуть → Redis отдавал ключ обратно, на следующем
 *   tick'е heartbeat видел mismatch и аборт'ил импорт. В adhoc 1592
 *   парсинг 7114 партий → 0 added → backfill заблокирован.
 *
 *   600s покрывает не только парсинг (~2 мин), но и весь нормальный
 *   import одного issue (12–18 мин — нет, тогда нужно > 18 мин;
 *   600s = 10 мин достаточно для 90-perc парсинг + первый chunk-async
 *   yield, после которого heartbeat сможет tick'нуть и продлить TTL
 *   на следующие 10 мин). Полный import при штатных insert'ах
 *   укладывается в 1 heartbeat-period после парсинга.
 *
 *   Trade-off: после SIGKILL Fargate-task'а Redis ждёт TTL до
 *   освобождения ключа (теперь до 10 мин против 1 мин). Допустимо —
 *   adhoc-запуски это редкие операции, ловить 10-минутный wait при
 *   следующем CLI-запуске оператор видит и понимает.
 *
 *   Долгосрочный фикс — yield event loop в parseBatch (KS-2158
 *   follow-up: setImmediate каждые N партий) или worker_thread.
 *
 * KS-3150 (20.05.2026): twic1645 18-19.05 падал по lock-expire через
 * ~12 мин — выходим за окно 10-мин дефолта. Поднимаем не в коде, а
 * через ENV: devops добавляет `ARCHIVE_IMPORTER_LOCK_TTL_MS=3600000`
 * (1 час) в task-def `kingside-archive-importer`. Дефолт в коде
 * остаётся 600s — env-override это позволяет.
 *
 * Экспортируется для тестов.
 */
export function resolveLockTimings(
  opts: Pick<AcquireLockOpts, 'ttlMs' | 'heartbeatMs'>,
  env: NodeJS.ProcessEnv = process.env,
): { ttlMs: number; heartbeatMs: number } {
  const fromEnv = (name: string): number | undefined => {
    const raw = env[name];
    if (!raw) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  const ttlMs =
    opts.ttlMs ??
    fromEnv('ARCHIVE_IMPORTER_LOCK_TTL_MS') ??
    600_000;
  const heartbeatMs =
    opts.heartbeatMs ??
    fromEnv('ARCHIVE_IMPORTER_LOCK_HEARTBEAT_MS') ??
    Math.max(1_000, Math.floor(ttlMs / 2));
  return { ttlMs, heartbeatMs };
}

/**
 * Сериализует value lock'а: `<token>:<role>:<issue|->:<pid>`. Lua
 * сравнивает строку целиком — мы полагаемся на уникальность token'а
 * для безопасного release/extend. Meta-поля нужны только для лога и
 * duplicate-self detection в caller'е (см. KS-1896).
 *
 * Экспортируется для тестов.
 */
export function buildLockValue(
  token: string,
  role: LockRole,
  issue: number | undefined,
  pid: number,
): string {
  return `${token}:${role}:${issue ?? '-'}:${pid}`;
}

/**
 * Пытается захватить lock через `SET NX PX <ttl>`. При успехе
 * возвращает `AcquiredLock`, у которого release/heartbeat защищены
 * Lua-скриптами по token'у. При неудаче — `null` (lock держит
 * другой процесс; caller решает, ждать или падать).
 */
export async function acquireLock(
  opts: AcquireLockOpts,
): Promise<AcquiredLock | null> {
  const { ttlMs, heartbeatMs } = resolveLockTimings(opts);
  const token = (opts.randomUUID ?? nodeRandomUUID)();
  const pid = opts.pid ?? process.pid;
  const value = buildLockValue(token, opts.role, opts.issue, pid);

  // SET key value NX PX ttl. Используем PX вместо EX — ms-точность
  // совпадает с heartbeat'ом (PEXPIRE).
  const r = await opts.redis
    .set(opts.key, value, 'PX', ttlMs, 'NX')
    .catch((err) => {
      // Redis flap → транслируем как «не получилось». Caller сам
      // решит retry vs fail, helper не знает политики.
      opts.logger?.warn?.(
        `acquireLock SET ${opts.key} failed: ${(err as Error).message}`,
      );
      return null;
    });
  if (r !== 'OK') return null;

  return attachHeartbeat({
    ...opts,
    token,
    value,
    ttlMs,
    heartbeatMs,
  });
}

/**
 * Внутренние опции `attachHeartbeat`. Выделено в отдельный helper,
 * чтобы CLI с pre-existing wait-loop'ом (`acquireLockWithWait`,
 * KS-1896) мог сначала сделать SET сам (с poll/wait), а потом
 * «промоутить» успешный SET в полноценный `AcquiredLock` с
 * heartbeat'ом — БЕЗ повторного SET-NX (двойной SET ломает race
 * с другими процессами).
 */
export interface AttachHeartbeatOpts
  extends Omit<AcquireLockOpts, 'role' | 'issue' | 'pid' | 'randomUUID'> {
  /** Токен, уже зашитый в `value`. Hex/UUID, ровно та строка, что в SET. */
  token: string;
  /** Полное значение в Redis (`<token>:<role>:<issue|->:<pid>`). */
  value: string;
  /** Реально применённый TTL (после env override'ов). */
  ttlMs: number;
  /** Реально применённый heartbeat-период. */
  heartbeatMs: number;
}

/**
 * Привязывает heartbeat и release-helper к УЖЕ ЗАХВАЧЕННОМУ lock'у
 * (caller гарантирует, что `SET NX value PX ttl` отработал OK).
 *
 * Используется в двух сценариях:
 *   1. `acquireLock()` (выше) — однократный SET, простой случай.
 *   2. CLI с wait-loop'ом (KS-1896) — wait-loop сам делает SET через
 *      `acquireLockWithWait`; успех «промоутится» в `AcquiredLock`
 *      этим helper'ом.
 */
export function attachHeartbeat(opts: AttachHeartbeatOpts): AcquiredLock {
  const { ttlMs, heartbeatMs, value, token } = opts;
  const setIntervalFn = opts.setInterval ?? globalSetInterval;
  const clearIntervalFn = opts.clearInterval ?? globalClearInterval;

  let heartbeatHandle: unknown = undefined;
  let released = false;
  // KS-2156: AbortController для сигнала «lock потерян». release() его не
  // дёргает — это нормальное завершение, а только heartbeat-fail / lock-loss.
  const abortController = new AbortController();

  const stopHeartbeat = () => {
    if (heartbeatHandle !== undefined) {
      clearIntervalFn(heartbeatHandle);
      heartbeatHandle = undefined;
    }
  };

  const abortDueToLockLoss = (reason: string): void => {
    if (abortController.signal.aborted) return;
    abortController.abort(new Error(`lock lost: ${reason}`));
  };

  // Heartbeat — отдельный setInterval. Не используем setTimeout-цепочку
  // (без catch'ей это утечёт promise rejection). Внутри tick'а ловим
  // ошибки, чтобы один редкий сбой Redis не убивал весь импорт.
  let tickCount = 0;
  if (!opts.disableHeartbeat) {
    heartbeatHandle = setIntervalFn(() => {
      void heartbeatTickValue(opts, value, ttlMs).then((outcome) => {
        if (outcome === 'ok') {
          // KS-2180: явный info-сигнал «процесс жив» каждые heartbeatMs
          // (default 5 мин). Раньше успешный tick тихий — devops не
          // мог отличить медленный импорт от полного freeze.
          tickCount++;
          opts.logger?.log?.(
            `lock "${opts.key}" alive: token=${token.slice(0, 8)}… ` +
              `tick=${tickCount} ttl=${Math.floor(ttlMs / 1000)}s`,
          );
          return;
        }
        // Lock потерян (mismatch или Redis-ошибка). Останавливаем
        // heartbeat и сигнализируем caller'у через AbortSignal —
        // тот должен прервать активный импорт, иначе мы уже не
        // владельцы lock'а, а наш импорт продолжается параллельно
        // с тем, кто его перехватил (инцидент 29.04, KS-2156).
        const reason =
          outcome === 'mismatch'
            ? 'token mismatch (key stolen or expired)'
            : 'heartbeat error (Redis unreachable)';
        opts.logger?.warn?.(
          `lock "${opts.key}" no longer held by us (token=${token.slice(0, 8)}…, reason=${reason}); ` +
            `heartbeat stopped, signalling abort to caller`,
        );
        stopHeartbeat();
        abortDueToLockLoss(reason);
      });
    }, heartbeatMs);
  }

  const release = async (): Promise<boolean> => {
    if (released) return false;
    released = true;
    stopHeartbeat();
    try {
      const result = await opts.redis.eval(RELEASE_LUA, 1, opts.key, value);
      return Number(result) === 1;
    } catch (err) {
      opts.logger?.warn?.(
        `lock "${opts.key}" release Lua failed: ${(err as Error).message}; ` +
          `relying on TTL=${ttlMs}ms`,
      );
      return false;
    }
  };

  return {
    token,
    value,
    heartbeatMs,
    ttlMs,
    signal: abortController.signal,
    release,
  };
}

/**
 * Один tick heartbeat'а. KS-2156: возвращает разные исходы, чтобы caller
 * мог различить «нас перехватили» (mismatch) и «Redis отвалился» (error)
 * — оба означают потерю lock'а, но в логе пишем разную причину.
 *
 *   - `ok`       — PEXPIRE прошёл, lock всё ещё наш.
 *   - `mismatch` — Redis вернул 0 (GET != token, ключ перехвачен/истёк).
 *   - `error`    — EVAL бросил исключение (gracefully degrade — не падаем).
 */
async function heartbeatTickValue(
  opts: Pick<AttachHeartbeatOpts, 'redis' | 'key' | 'logger'>,
  value: string,
  ttlMs: number,
): Promise<'ok' | 'mismatch' | 'error'> {
  try {
    const r = await opts.redis.eval(
      EXTEND_LUA,
      1,
      opts.key,
      value,
      String(ttlMs),
    );
    return Number(r) === 1 ? 'ok' : 'mismatch';
  } catch (err) {
    opts.logger?.warn?.(
      `lock "${opts.key}" heartbeat failed: ${(err as Error).message}`,
    );
    return 'error';
  }
}

const globalSetInterval = (cb: () => void, ms: number) => setInterval(cb, ms);
const globalClearInterval = (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>);
