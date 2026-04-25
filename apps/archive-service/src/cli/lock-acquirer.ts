/**
 * Wait-with-timeout helper для распределённых Redis-локов
 * (`SET key value EX ttl NX`) — KS-1896.
 *
 * Проблема, которую решает: ad-hoc CLI импортёра делил lock
 * `archive:import:lock:twic` со scheduled importer (EventBridge,
 * ADR-020). Если в момент запуска CLI scheduler уже импортирует —
 * `SET NX` возвращал `null`, и CLI **мгновенно** падал с
 * `Fatal error: lock is held`. Оператор тратил 12-18 минут на ожидание
 * следующей попытки руками. KS-1893 был третьим случаем за месяц.
 *
 * Контракт:
 *   - Helper НЕ знает про доменную семантику lock'а; он только пытается
 *     взять и при неудаче ретраит до `waitTimeoutMs`. Caller сам
 *     решает, что значит holder и какой exit-code мапить на reason.
 *   - `isDuplicateSelf(holder)` (опц.) даёт caller'у возможность
 *     отличить «scheduler работает» от «двойной запуск adhoc» —
 *     если callback вернул `true`, helper **не ждёт** и сразу отдаёт
 *     `reason: 'duplicate-self'`. Двойной adhoc-запуск — пользовательская
 *     ошибка, эскалировать сразу.
 *   - `waitTimeoutMs <= 0` — не ждать вовсе (legacy-поведение, для
 *     `ARCHIVE_IMPORTER_LOCK_NO_WAIT=1`).
 *   - Лог progress'а на каждом неуспешном attempt'е через `logger.log`,
 *     чтобы оператор видел «жду lock, держит X, попытка #N».
 *
 * Helper и его тесты независимы от NestJS, импортёра и shape'а
 * `ArchiveSourceRow` — это just timing+IO модуль.
 */

import type Redis from 'ioredis';
import type { Logger } from '@nestjs/common';

export type LockAcquirerRedis = Pick<Redis, 'set' | 'get'>;

export interface AcquireLockOpts {
  redis: LockAcquirerRedis;
  lockKey: string;
  lockValue: string;
  /** TTL Redis-ключа при удачном `SET NX` (защита от висящего lock'а). */
  lockTtlSec: number;
  /**
   * Максимальное время ожидания. `0` или меньше — не ждать вообще,
   * вернуть `reason: 'no-wait-disabled'` при первом `null` от SET.
   */
  waitTimeoutMs: number;
  /** Интервал между attempt'ами SET. Финальный sleep укорачивается до remaining timeout'а. */
  pollIntervalMs: number;
  /**
   * Для отличения «scheduler держит lock» (надо ждать) от «adhoc CLI
   * с тем же issue» (надо упасть сразу). Принимает текущее значение
   * lock'а из `GET` (или `null`/`undefined`, если ключа нет). Если
   * вернул `true` — helper отдаёт `reason: 'duplicate-self'`, attempts
   * больше не делает.
   */
  isDuplicateSelf?: (currentHolder: string | null) => boolean;
  /**
   * Логгер для прогресса. Один лог на каждый failed attempt: «жду
   * lock, держит X, попытка #N, прошло Yc, дам ещё Zс».
   */
  logger?: Pick<Logger, 'log' | 'warn'>;
  /** Hook для тестов: подменить Date.now(). */
  now?: () => number;
  /** Hook для тестов: подменить setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface AcquireLockResult {
  acquired: boolean;
  reason?: 'timeout' | 'duplicate-self' | 'no-wait-disabled';
  /** Содержимое lock-value текущего holder'а (последний GET перед выходом). */
  heldBy?: string | null;
  /** Время от первого attempt'а до возврата (для логов/метрик). */
  waitedMs: number;
  /** Сколько раз выполнен `SET NX` (включая успешный, если acquired). */
  attempts: number;
}

/**
 * Пытается взять Redis-lock через `SET NX`, при неудаче — ждёт и
 * ретраит до `waitTimeoutMs`. Подробности — в JSDoc файла.
 */
export async function acquireLockWithWait(
  opts: AcquireLockOpts,
): Promise<AcquireLockResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const start = now();

  let attempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempts++;
    const r = await opts.redis
      .set(opts.lockKey, opts.lockValue, 'EX', opts.lockTtlSec, 'NX')
      .catch(() => null);
    if (r === 'OK') {
      return {
        acquired: true,
        waitedMs: now() - start,
        attempts,
      };
    }

    // Lock занят — кто? GET может тоже упасть (Redis flap), это не
    // критично: caller всё равно дождётся timeout'а или duplicate-self
    // (для duplicate-self holder обязателен, поэтому при null callback
    // должен возвращать false — что и логично: «не знаю — ждём»).
    const holder = await opts.redis.get(opts.lockKey).catch(() => null);

    if (opts.isDuplicateSelf?.(holder ?? null)) {
      return {
        acquired: false,
        reason: 'duplicate-self',
        heldBy: holder,
        waitedMs: now() - start,
        attempts,
      };
    }

    // Legacy-режим: ARCHIVE_IMPORTER_LOCK_NO_WAIT=1 у caller'а маппится
    // в waitTimeoutMs<=0 — отдаём отдельный reason, чтобы caller вернул
    // прежнее сообщение и exit-code.
    if (opts.waitTimeoutMs <= 0) {
      return {
        acquired: false,
        reason: 'no-wait-disabled',
        heldBy: holder,
        waitedMs: now() - start,
        attempts,
      };
    }

    const elapsed = now() - start;
    if (elapsed >= opts.waitTimeoutMs) {
      return {
        acquired: false,
        reason: 'timeout',
        heldBy: holder,
        waitedMs: elapsed,
        attempts,
      };
    }

    opts.logger?.log?.(
      `waiting for lock "${opts.lockKey}" — held by ${holder ?? 'unknown holder'}; ` +
        `attempt #${attempts}, waited ${Math.floor(elapsed / 1000)}s, ` +
        `give up after ${Math.floor(opts.waitTimeoutMs / 1000)}s`,
    );

    // Не спим дольше, чем осталось до timeout'а — иначе уйдём в overshoot.
    const remaining = opts.waitTimeoutMs - elapsed;
    await sleep(Math.min(opts.pollIntervalMs, remaining));
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
