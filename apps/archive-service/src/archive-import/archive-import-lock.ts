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
  /** TTL ключа в Redis. Default 60_000 ms. */
  ttlMs?: number;
  /** Период heartbeat'а. Default 30_000 ms (= ttl/2). */
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
 * чтобы prod мог поднять/опустить значения без пересборки. Дефолты
 * подобраны под scheduler'ный TWIC-импорт (~12-18 мин), но
 * консервативные — чтобы heartbeat успевал в ECS-сети с jitter'ом.
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
    60_000;
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

  const stopHeartbeat = () => {
    if (heartbeatHandle !== undefined) {
      clearIntervalFn(heartbeatHandle);
      heartbeatHandle = undefined;
    }
  };

  // Heartbeat — отдельный setInterval. Не используем setTimeout-цепочку
  // (без catch'ей это утечёт promise rejection). Внутри tick'а ловим
  // ошибки, чтобы один редкий сбой Redis не убивал весь импорт.
  if (!opts.disableHeartbeat) {
    heartbeatHandle = setIntervalFn(() => {
      void heartbeatTickValue(opts, value, ttlMs).then((stillOurs) => {
        if (!stillOurs) {
          // Кто-то перехватил lock или ключ исчез. Останавливаем
          // heartbeat — продолжать тикать бессмысленно (мы больше
          // не владельцы). Текущий импорт продолжается, но при
          // release вернём false. Это видимая ошибка только в логе.
          opts.logger?.warn?.(
            `lock "${opts.key}" no longer held by us (token=${token.slice(0, 8)}…); ` +
              `heartbeat stopped`,
          );
          stopHeartbeat();
        }
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

  return { token, value, heartbeatMs, ttlMs, release };
}

/**
 * Один tick heartbeat'а. Возвращает `true` если PEXPIRE прошёл
 * (lock всё ещё наш), `false` — если токен уже не совпадает или
 * Redis вернул ошибку (gracefully degrade — не падаем).
 */
async function heartbeatTickValue(
  opts: Pick<AttachHeartbeatOpts, 'redis' | 'key' | 'logger'>,
  value: string,
  ttlMs: number,
): Promise<boolean> {
  try {
    const r = await opts.redis.eval(
      EXTEND_LUA,
      1,
      opts.key,
      value,
      String(ttlMs),
    );
    return Number(r) === 1;
  } catch (err) {
    opts.logger?.warn?.(
      `lock "${opts.key}" heartbeat failed: ${(err as Error).message}`,
    );
    return false;
  }
}

const globalSetInterval = (cb: () => void, ms: number) => setInterval(cb, ms);
const globalClearInterval = (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>);
