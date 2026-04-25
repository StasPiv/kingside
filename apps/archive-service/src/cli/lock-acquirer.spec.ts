import { acquireLockWithWait, type LockAcquirerRedis } from './lock-acquirer';

/**
 * Юнит-тесты для `acquireLockWithWait` (KS-1896). Тесты не используют
 * реальный Redis и реальный setTimeout — `now`/`sleep` инжектируются.
 * Это даёт детерминированный замер `waitedMs` и время прогона < 50ms.
 */

interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
  sleep: jest.Mock<Promise<void>, [ms: number]>;
}

function makeFakeClock(): FakeClock {
  let t = 1_000_000;
  const advance = (ms: number) => {
    t += ms;
  };
  const sleep = jest.fn<Promise<void>, [ms: number]>(async (ms) => {
    advance(ms);
  });
  return { now: () => t, advance, sleep };
}

interface FakeRedisOpts {
  /** Очередь ответов от SET NX. После исчерпания — последний элемент повторяется. */
  setReturns: Array<'OK' | null>;
  /** Очередь ответов от GET (опц.). После исчерпания — `null`. */
  getReturns?: Array<string | null>;
  /** SET бросает на каждом вызове? Симуляция Redis flap. */
  setThrows?: boolean;
  /** GET бросает? */
  getThrows?: boolean;
}

function makeFakeRedis(opts: FakeRedisOpts): {
  redis: LockAcquirerRedis;
  setCalls: jest.Mock;
  getCalls: jest.Mock;
} {
  let setIdx = 0;
  const setCalls = jest.fn(async () => {
    if (opts.setThrows) throw new Error('redis SET ECONNREFUSED');
    const i = Math.min(setIdx, opts.setReturns.length - 1);
    setIdx++;
    return opts.setReturns[i];
  });
  let getIdx = 0;
  const getCalls = jest.fn(async () => {
    if (opts.getThrows) throw new Error('redis GET ECONNREFUSED');
    const list = opts.getReturns ?? [];
    if (getIdx >= list.length) return null;
    return list[getIdx++];
  });
  return {
    redis: { set: setCalls as never, get: getCalls as never },
    setCalls,
    getCalls,
  };
}

const KEY = 'archive:import:lock:twic';
const VALUE = '99:1700000000:adhoc:1639';
const TTL = 1800;

describe('acquireLockWithWait — happy path', () => {
  it('SET NX вернул OK с первой попытки → acquired:true, без sleep', async () => {
    const clock = makeFakeClock();
    const { redis, setCalls, getCalls } = makeFakeRedis({ setReturns: ['OK'] });

    const r = await acquireLockWithWait({
      redis,
      lockKey: KEY,
      lockValue: VALUE,
      lockTtlSec: TTL,
      waitTimeoutMs: 30_000,
      pollIntervalMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(r.acquired).toBe(true);
    expect(r.waitedMs).toBe(0);
    expect(r.attempts).toBe(1);
    expect(setCalls).toHaveBeenCalledTimes(1);
    expect(setCalls).toHaveBeenCalledWith(KEY, VALUE, 'EX', TTL, 'NX');
    expect(getCalls).not.toHaveBeenCalled();
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('lock освобождается после N попыток → берём, считаем attempts/waitedMs', async () => {
    const clock = makeFakeClock();
    const { redis, setCalls, getCalls } = makeFakeRedis({
      setReturns: [null, null, 'OK'],
      getReturns: ['scheduler:1700:scheduled', 'scheduler:1700:scheduled'],
    });

    const logger = { log: jest.fn(), warn: jest.fn() };

    const r = await acquireLockWithWait({
      redis,
      lockKey: KEY,
      lockValue: VALUE,
      lockTtlSec: TTL,
      waitTimeoutMs: 60_000,
      pollIntervalMs: 5_000,
      logger,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(r.acquired).toBe(true);
    expect(r.attempts).toBe(3);
    // Два sleep по 5с (после 1-й и 2-й неудачи).
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenNthCalledWith(1, 5_000);
    expect(clock.sleep).toHaveBeenNthCalledWith(2, 5_000);
    expect(r.waitedMs).toBe(10_000);
    // GET звался на каждой неудачной попытке, чтобы достать holder.
    expect(getCalls).toHaveBeenCalledTimes(2);
    // Лог progress'а — два раза, по одному на каждую неудачу.
    expect(logger.log).toHaveBeenCalledTimes(2);
    expect(logger.log.mock.calls[0][0]).toMatch(/waiting for lock/);
    expect(setCalls).toHaveBeenCalledTimes(3);
  });
});

describe('acquireLockWithWait — duplicate-self', () => {
  it('isDuplicateSelf вернул true с первого GET → reason=duplicate-self, без sleep', async () => {
    const clock = makeFakeClock();
    const { redis, setCalls, getCalls } = makeFakeRedis({
      setReturns: [null],
      getReturns: ['11:1700:adhoc:1639'],
    });

    const r = await acquireLockWithWait({
      redis,
      lockKey: KEY,
      lockValue: VALUE,
      lockTtlSec: TTL,
      waitTimeoutMs: 30_000,
      pollIntervalMs: 5_000,
      isDuplicateSelf: (holder) => holder?.endsWith(':adhoc:1639') ?? false,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(r.acquired).toBe(false);
    expect(r.reason).toBe('duplicate-self');
    expect(r.heldBy).toBe('11:1700:adhoc:1639');
    expect(r.attempts).toBe(1);
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(setCalls).toHaveBeenCalledTimes(1);
    expect(getCalls).toHaveBeenCalledTimes(1);
  });

  it('isDuplicateSelf на null от GET — false (не знаем holder, ждём)', async () => {
    const clock = makeFakeClock();
    const { redis } = makeFakeRedis({
      setReturns: [null, 'OK'],
      getReturns: [null], // Redis GET вернул null, ключ исчез между SET и GET
    });

    const r = await acquireLockWithWait({
      redis,
      lockKey: KEY,
      lockValue: VALUE,
      lockTtlSec: TTL,
      waitTimeoutMs: 30_000,
      pollIntervalMs: 5_000,
      // Эта реализация считает null → не дубль (мы ждём, не падаем).
      isDuplicateSelf: (holder) => holder?.endsWith(':adhoc:1639') ?? false,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(r.acquired).toBe(true);
    expect(r.attempts).toBe(2);
  });
});

describe('acquireLockWithWait — timeout', () => {
  it('lock не освобождается → reason=timeout, waitedMs >= timeout', async () => {
    const clock = makeFakeClock();
    const { redis, setCalls } = makeFakeRedis({
      setReturns: [null],
      // 4 attempt'а будут — даём holder для каждого, чтобы heldBy
      // итогового результата не стал null на исчерпании очереди.
      getReturns: [
        'scheduler:1700:scheduled',
        'scheduler:1700:scheduled',
        'scheduler:1700:scheduled',
        'scheduler:1700:scheduled',
      ],
    });

    const logger = { log: jest.fn(), warn: jest.fn() };

    const r = await acquireLockWithWait({
      redis,
      lockKey: KEY,
      lockValue: VALUE,
      lockTtlSec: TTL,
      waitTimeoutMs: 12_000,
      pollIntervalMs: 5_000,
      logger,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(r.acquired).toBe(false);
    expect(r.reason).toBe('timeout');
    expect(r.heldBy).toBe('scheduler:1700:scheduled');
    expect(r.waitedMs).toBeGreaterThanOrEqual(12_000);
    // attempt #1 → sleep 5_000, #2 → sleep 5_000, #3 → остаётся 2_000 (clamp), #4 → elapsed=12_000 → timeout
    expect(setCalls).toHaveBeenCalledTimes(4);
    // Финальный sleep укорачивается до remaining < pollInterval.
    expect(clock.sleep).toHaveBeenNthCalledWith(3, 2_000);
  });

  it('последний sleep не превышает remaining timeout (clamp)', async () => {
    const clock = makeFakeClock();
    const { redis } = makeFakeRedis({ setReturns: [null] });

    await acquireLockWithWait({
      redis,
      lockKey: KEY,
      lockValue: VALUE,
      lockTtlSec: TTL,
      waitTimeoutMs: 7_000,
      pollIntervalMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    // Первый sleep — 5_000, второй — 2_000 (timeout - 5_000), потом timeout.
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenNthCalledWith(1, 5_000);
    expect(clock.sleep).toHaveBeenNthCalledWith(2, 2_000);
  });
});

describe('acquireLockWithWait — no-wait-disabled', () => {
  it('waitTimeoutMs=0 + lock занят → reason=no-wait-disabled сразу, без sleep/get-loop\'ов', async () => {
    const clock = makeFakeClock();
    const { redis, setCalls, getCalls } = makeFakeRedis({
      setReturns: [null],
      getReturns: ['scheduler:1700:scheduled'],
    });

    const r = await acquireLockWithWait({
      redis,
      lockKey: KEY,
      lockValue: VALUE,
      lockTtlSec: TTL,
      waitTimeoutMs: 0,
      pollIntervalMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(r.acquired).toBe(false);
    expect(r.reason).toBe('no-wait-disabled');
    expect(r.heldBy).toBe('scheduler:1700:scheduled');
    expect(setCalls).toHaveBeenCalledTimes(1);
    expect(getCalls).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('waitTimeoutMs=0 + lock свободен → всё равно берём (acquired:true)', async () => {
    const { redis } = makeFakeRedis({ setReturns: ['OK'] });
    const r = await acquireLockWithWait({
      redis,
      lockKey: KEY,
      lockValue: VALUE,
      lockTtlSec: TTL,
      waitTimeoutMs: 0,
      pollIntervalMs: 5_000,
    });
    expect(r.acquired).toBe(true);
  });
});

describe('acquireLockWithWait — устойчивость к Redis-flap', () => {
  it('SET бросает → trактуется как null (lock занят), не падаем', async () => {
    const clock = makeFakeClock();
    const { redis } = makeFakeRedis({ setReturns: [null], setThrows: true });

    const r = await acquireLockWithWait({
      redis,
      lockKey: KEY,
      lockValue: VALUE,
      lockTtlSec: TTL,
      waitTimeoutMs: 0, // быстро завершимся через no-wait
      pollIntervalMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(r.acquired).toBe(false);
    expect(r.reason).toBe('no-wait-disabled');
  });

  it('GET бросает → holder=null, продолжаем wait-loop', async () => {
    const clock = makeFakeClock();
    const { redis } = makeFakeRedis({
      setReturns: [null, 'OK'],
      getThrows: true,
    });

    const r = await acquireLockWithWait({
      redis,
      lockKey: KEY,
      lockValue: VALUE,
      lockTtlSec: TTL,
      waitTimeoutMs: 30_000,
      pollIntervalMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(r.acquired).toBe(true);
    expect(r.attempts).toBe(2);
  });
});
