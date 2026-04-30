import {
  acquireLock,
  buildLockValue,
  EXTEND_LUA,
  RELEASE_LUA,
  resolveLockTimings,
  type AcquireLockRedis,
} from './archive-import-lock';

/**
 * Юнит-тесты helper'а Redis-lock'а с heartbeat'ом (KS-1898).
 * Не используют реальный Redis или таймеры: SET/GET/EVAL и
 * setInterval/clearInterval инжектируются.
 */

interface FakeRedisOpts {
  setReturns?: Array<'OK' | null>;
  /** Сценарий ответов EVAL: i-й вызов вернёт returns[i] (или последний, если массив короче). */
  evalReturns?: Array<number | string>;
  setThrows?: boolean;
  evalThrows?: boolean;
}

function makeFakeRedis(opts: FakeRedisOpts = {}) {
  let setIdx = 0;
  const set = jest.fn(async (..._args: unknown[]) => {
    if (opts.setThrows) throw new Error('redis SET ECONNREFUSED');
    const list = opts.setReturns ?? ['OK'];
    const i = Math.min(setIdx, list.length - 1);
    setIdx++;
    return list[i];
  });
  const get = jest.fn(async () => null);
  let evalIdx = 0;
  const eval_ = jest.fn(async (..._args: unknown[]) => {
    if (opts.evalThrows) throw new Error('redis EVAL ECONNREFUSED');
    const list = opts.evalReturns ?? [1];
    const i = Math.min(evalIdx, list.length - 1);
    evalIdx++;
    return list[i];
  });
  return {
    redis: { set, get, eval: eval_ } as unknown as AcquireLockRedis,
    set,
    get,
    eval_,
  };
}

interface FakeIntervals {
  setInterval: jest.Mock;
  clearInterval: jest.Mock;
  /** Запускает все pending tick'и (по одному разу). Возвращает promise, чтобы дождаться async-обработки в callback'е. */
  flushTicks: () => Promise<void>;
  /** Сколько активных interval'ов. */
  active: () => number;
}

function makeFakeIntervals(): FakeIntervals {
  const intervals = new Map<number, () => void>();
  let nextId = 1;
  const setIntervalFn = jest.fn((cb: () => void, _ms: number) => {
    const id = nextId++;
    intervals.set(id, cb);
    return id;
  });
  const clearIntervalFn = jest.fn((h: unknown) => {
    intervals.delete(h as number);
  });
  const flushTicks = async () => {
    for (const cb of [...intervals.values()]) cb();
    // Дать микротаскам в heartbeat-callback'е завершиться.
    await new Promise<void>((res) => setImmediate(res));
  };
  return {
    setInterval: setIntervalFn,
    clearInterval: clearIntervalFn,
    flushTicks,
    active: () => intervals.size,
  };
}

const KEY = 'archive:import:lock:twic';

// ─── Конфиг таймингов ──────────────────────────────────────────────

describe('resolveLockTimings', () => {
  it('дефолты — 600s TTL и 300s heartbeat (KS-2157: parseBatch блокирует event loop)', () => {
    expect(resolveLockTimings({}, {})).toEqual({
      ttlMs: 600_000,
      heartbeatMs: 300_000,
    });
  });

  it('явные opts перебивают env', () => {
    expect(
      resolveLockTimings(
        { ttlMs: 10_000, heartbeatMs: 4_000 },
        {
          ARCHIVE_IMPORTER_LOCK_TTL_MS: '999',
          ARCHIVE_IMPORTER_LOCK_HEARTBEAT_MS: '111',
        },
      ),
    ).toEqual({ ttlMs: 10_000, heartbeatMs: 4_000 });
  });

  it('env перебивает дефолт', () => {
    expect(
      resolveLockTimings(
        {},
        {
          ARCHIVE_IMPORTER_LOCK_TTL_MS: '20000',
          ARCHIVE_IMPORTER_LOCK_HEARTBEAT_MS: '5000',
        },
      ),
    ).toEqual({ ttlMs: 20_000, heartbeatMs: 5_000 });
  });

  it('heartbeat по умолчанию = ttl/2 (минимум 1с)', () => {
    expect(resolveLockTimings({ ttlMs: 4_000 }, {})).toEqual({
      ttlMs: 4_000,
      heartbeatMs: 2_000,
    });
    // ttlMs=500 → ttl/2=250, но clamp до 1000.
    expect(resolveLockTimings({ ttlMs: 500 }, {})).toEqual({
      ttlMs: 500,
      heartbeatMs: 1_000,
    });
  });

  it('мусорные env-значения игнорируются — fallback на дефолт 600s/300s', () => {
    expect(
      resolveLockTimings(
        {},
        { ARCHIVE_IMPORTER_LOCK_TTL_MS: 'oops', ARCHIVE_IMPORTER_LOCK_HEARTBEAT_MS: '-5' },
      ),
    ).toEqual({ ttlMs: 600_000, heartbeatMs: 300_000 });
  });
});

describe('buildLockValue', () => {
  it('включает токен, роль, issue, pid', () => {
    expect(buildLockValue('uuid-1', 'adhoc', 1639, 12345)).toBe(
      'uuid-1:adhoc:1639:12345',
    );
  });

  it('issue=undefined → "-"', () => {
    expect(buildLockValue('uuid-1', 'scheduler', undefined, 999)).toBe(
      'uuid-1:scheduler:-:999',
    );
  });
});

// ─── acquireLock — happy path ──────────────────────────────────────

describe('acquireLock — happy', () => {
  it('SET NX PX <ttl>, формат value, возвращает handle', async () => {
    const r = makeFakeRedis();
    const t = makeFakeIntervals();

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'adhoc',
      issue: 1639,
      pid: 7777,
      randomUUID: () => 'fixed-uuid',
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });

    expect(lock).not.toBeNull();
    expect(lock!.token).toBe('fixed-uuid');
    expect(lock!.value).toBe('fixed-uuid:adhoc:1639:7777');
    // KS-2157: дефолты 600s TTL / 300s heartbeat — гарантированный
    // запас над event-loop-blocking parseBatch (~2 мин на 7K партий).
    expect(lock!.ttlMs).toBe(600_000);
    expect(lock!.heartbeatMs).toBe(300_000);

    expect(r.set).toHaveBeenCalledTimes(1);
    expect(r.set).toHaveBeenCalledWith(
      KEY,
      'fixed-uuid:adhoc:1639:7777',
      'PX',
      600_000,
      'NX',
    );
    // setInterval запущен на 300 сек (heartbeat = ttl/2).
    expect(t.setInterval).toHaveBeenCalledWith(expect.any(Function), 300_000);
    expect(t.active()).toBe(1);
  });

  it('lock занят (SET вернул null) → null', async () => {
    const r = makeFakeRedis({ setReturns: [null] });
    const t = makeFakeIntervals();

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'adhoc',
      issue: 1639,
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });

    expect(lock).toBeNull();
    // Heartbeat не запущен.
    expect(t.setInterval).not.toHaveBeenCalled();
    expect(t.active()).toBe(0);
  });

  it('Redis SET бросает → null (не падаем, не запускаем heartbeat)', async () => {
    const r = makeFakeRedis({ setThrows: true });
    const t = makeFakeIntervals();
    const logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'scheduler',
      logger,
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });

    expect(lock).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/SET/));
    expect(t.setInterval).not.toHaveBeenCalled();
  });

  it('disableHeartbeat:true → setInterval не вызывается', async () => {
    const r = makeFakeRedis();
    const t = makeFakeIntervals();

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'scheduler',
      disableHeartbeat: true,
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });

    expect(lock).not.toBeNull();
    expect(t.setInterval).not.toHaveBeenCalled();
  });
});

// ─── Heartbeat ─────────────────────────────────────────────────────

describe('acquireLock — heartbeat', () => {
  it('каждый tick вызывает EVAL EXTEND_LUA с token и ttl', async () => {
    const r = makeFakeRedis({ evalReturns: [1, 1, 1] });
    const t = makeFakeIntervals();

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'adhoc',
      issue: 1639,
      pid: 7,
      randomUUID: () => 'tok',
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });
    expect(lock).not.toBeNull();

    await t.flushTicks();
    expect(r.eval_).toHaveBeenCalledTimes(1);
    expect(r.eval_).toHaveBeenCalledWith(
      EXTEND_LUA,
      1,
      KEY,
      'tok:adhoc:1639:7',
      // KS-2157: TTL 600s по умолчанию (heartbeat extends на ttl).
      '600000',
    );

    await t.flushTicks();
    expect(r.eval_).toHaveBeenCalledTimes(2);
  });

  it('если EXTEND вернул 0 (нас перехватили) → heartbeat останавливается', async () => {
    const r = makeFakeRedis({ evalReturns: [1, 0, 1] }); // 2-й tick = mismatch
    const t = makeFakeIntervals();
    const logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'adhoc',
      issue: 1639,
      logger,
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });
    expect(lock).not.toBeNull();

    await t.flushTicks(); // tick #1 → 1, продолжаем
    expect(t.active()).toBe(1);

    await t.flushTicks(); // tick #2 → 0, останавливаемся
    expect(t.active()).toBe(0);
    expect(t.clearInterval).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/no longer held by us/),
    );

    // Дальнейших EVAL быть не должно — interval удалён.
    await t.flushTicks();
    expect(r.eval_).toHaveBeenCalledTimes(2);
  });

  it('Redis EVAL бросает → heartbeat степенно останавливается, основной поток не падает', async () => {
    const r = makeFakeRedis({ evalThrows: true });
    const t = makeFakeIntervals();
    const logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'scheduler',
      logger,
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });
    expect(lock).not.toBeNull();

    await t.flushTicks(); // tick → throw → heartbeat stopped
    expect(t.active()).toBe(0);
    // Heartbeat-warn (от tick) — основной error не пробрасывается.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/heartbeat failed/),
    );
  });
});

// ─── Release ───────────────────────────────────────────────────────

describe('AcquiredLock.release', () => {
  it('вызывает EVAL RELEASE_LUA с key и value', async () => {
    const r = makeFakeRedis({ evalReturns: [1] });
    const t = makeFakeIntervals();

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'adhoc',
      issue: 1639,
      pid: 99,
      randomUUID: () => 'mytoken',
      disableHeartbeat: true,
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });

    const ok = await lock!.release();
    expect(ok).toBe(true);
    expect(r.eval_).toHaveBeenCalledWith(
      RELEASE_LUA,
      1,
      KEY,
      'mytoken:adhoc:1639:99',
    );
  });

  it('Lua вернул 0 (чужой токен) → release отдаёт false (не наша проблема)', async () => {
    const r = makeFakeRedis({ evalReturns: [0] });
    const t = makeFakeIntervals();

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'adhoc',
      disableHeartbeat: true,
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });

    const ok = await lock!.release();
    expect(ok).toBe(false);
  });

  it('повторный release — no-op (idempotent)', async () => {
    const r = makeFakeRedis({ evalReturns: [1] });
    const t = makeFakeIntervals();

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'adhoc',
      disableHeartbeat: true,
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });

    expect(await lock!.release()).toBe(true);
    expect(await lock!.release()).toBe(false);
    expect(r.eval_).toHaveBeenCalledTimes(1);
  });

  it('release останавливает heartbeat (clearInterval вызывается)', async () => {
    const r = makeFakeRedis({ evalReturns: [1, 1] });
    const t = makeFakeIntervals();

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'adhoc',
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });

    expect(t.active()).toBe(1);
    await lock!.release();
    expect(t.active()).toBe(0);
    expect(t.clearInterval).toHaveBeenCalled();
  });

  it('Redis EVAL бросает в release → false, лог warn, не пробрасывается', async () => {
    const r = makeFakeRedis({ evalThrows: true });
    const t = makeFakeIntervals();
    const logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'scheduler',
      disableHeartbeat: true,
      logger,
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });

    const ok = await lock!.release();
    expect(ok).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/release Lua failed/),
    );
  });
});

// ─── KS-2156: AbortSignal при потере lock'а ────────────────────────

describe('AcquiredLock.signal — KS-2156 abort на потере lock\'а', () => {
  it('KS-2180: успешный heartbeat пишет info "lock alive" с tick-номером', async () => {
    const r = makeFakeRedis({ evalReturns: [1, 1] });
    const t = makeFakeIntervals();
    const logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'scheduler',
      logger,
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });
    expect(lock).not.toBeNull();

    await t.flushTicks();
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/lock ".*" alive/));
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/tick=1/));

    await t.flushTicks();
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/tick=2/));
    // signal остаётся НЕ aborted при ok-tick'ах.
    expect(lock!.signal.aborted).toBe(false);
  });

  it('успешный heartbeat → signal не aborted', async () => {
    const r = makeFakeRedis({ evalReturns: [1, 1, 1] });
    const t = makeFakeIntervals();

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'scheduler',
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });
    expect(lock).not.toBeNull();
    expect(lock!.signal.aborted).toBe(false);

    await t.flushTicks();
    expect(lock!.signal.aborted).toBe(false);
  });

  it('mismatch (EXTEND вернул 0) → signal aborted с reason "lock lost: token mismatch..."', async () => {
    const r = makeFakeRedis({ evalReturns: [0] }); // первый же tick = mismatch
    const t = makeFakeIntervals();

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'scheduler',
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });
    expect(lock!.signal.aborted).toBe(false);

    await t.flushTicks();
    expect(lock!.signal.aborted).toBe(true);
    expect((lock!.signal.reason as Error).message).toMatch(
      /lock lost: token mismatch/,
    );
  });

  it('Redis EVAL throw → signal aborted с reason "lock lost: heartbeat error..."', async () => {
    const r = makeFakeRedis({ evalThrows: true });
    const t = makeFakeIntervals();
    const logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'scheduler',
      logger,
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });
    expect(lock!.signal.aborted).toBe(false);

    await t.flushTicks();
    expect(lock!.signal.aborted).toBe(true);
    expect((lock!.signal.reason as Error).message).toMatch(
      /lock lost: heartbeat error/,
    );
  });

  it('обычный release НЕ дёргает signal (нормальное завершение)', async () => {
    const r = makeFakeRedis({ evalReturns: [1] });
    const t = makeFakeIntervals();

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'scheduler',
      disableHeartbeat: true,
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });

    await lock!.release();
    expect(lock!.signal.aborted).toBe(false);
  });

  it('повторные mismatch не abort\'ят повторно (idempotent)', async () => {
    const r = makeFakeRedis({ evalReturns: [0, 0, 0] });
    const t = makeFakeIntervals();

    const lock = await acquireLock({
      redis: r.redis,
      key: KEY,
      role: 'scheduler',
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });

    await t.flushTicks();
    expect(lock!.signal.aborted).toBe(true);
    const firstReason = lock!.signal.reason;

    // Принудительно вызываем ещё раз (interval уже остановлен, но если бы
    // он был — abort оставался идемпотентным).
    await t.flushTicks();
    expect(lock!.signal.aborted).toBe(true);
    expect(lock!.signal.reason).toBe(firstReason);
  });
});

// ─── Race-сценарий (KS-1898 DoD) ───────────────────────────────────
//
// Два процесса. A берёт lock с token-A, его TTL «истёк» (симулируем —
// В реальности это случилось бы из-за heartbeat-фейла), B захватил
// lock с token-B. Когда A пытается release, Lua видит что в Redis
// уже token-B — DEL не делает. Lock B остаётся живым.

describe('release race — token mismatch не снимает чужой lock', () => {
  it('release с token-A на ключе с token-B → 0, lock B не тронут', async () => {
    const t = makeFakeIntervals();
    const evalA = jest.fn(async () => 0); // lua вернёт 0 — токен mismatch
    const setA = jest.fn(async () => 'OK');
    const getA = jest.fn(async () => null);

    const lockA = await acquireLock({
      redis: { set: setA, get: getA, eval: evalA } as never,
      key: KEY,
      role: 'adhoc',
      issue: 1639,
      randomUUID: () => 'token-a',
      disableHeartbeat: true,
      setInterval: t.setInterval as never,
      clearInterval: t.clearInterval as never,
    });

    const ok = await lockA!.release();
    expect(ok).toBe(false);
    // Lua-команда содержит value-A, не value-B — это и проверяем:
    expect(evalA).toHaveBeenCalledWith(
      RELEASE_LUA,
      1,
      KEY,
      'token-a:adhoc:1639:' + process.pid,
    );
  });
});
