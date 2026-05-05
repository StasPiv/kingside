/**
 * KS-2245. Юнит-тесты `TacticDrillIncrementalScheduler`.
 *
 * Покрытие:
 *  - tick без TACTIC_DRILL_INCREMENTAL_ENABLED → no-op;
 *  - tick без ARCHIVE_DATABASE_URL → warn + no-op;
 *  - lock-защита: повторный tick во время running → skip;
 *  - resetCursor → del.
 *
 * `runOnce` не вызываем напрямую (он тянет реальный pg + archive-БД);
 * проверяем что `tick()` вызывает `runOnce` корректно при ENV=1.
 */

import { TacticDrillIncrementalScheduler } from './tactic-drill-incremental.scheduler';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';

function makeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (k: string) => {
      const had = store.has(k);
      store.delete(k);
      return had ? 1 : 0;
    }),
  };
}

describe('TacticDrillIncrementalScheduler — KS-2245', () => {
  let prisma: PrismaService;
  let redis: ReturnType<typeof makeRedis>;
  let scheduler: TacticDrillIncrementalScheduler;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    prisma = {} as PrismaService;
    redis = makeRedis();
    scheduler = new TacticDrillIncrementalScheduler(
      prisma,
      redis as unknown as RedisService,
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('tick без ENV=1 → no-op (runOnce не вызывается)', async () => {
    delete process.env.TACTIC_DRILL_INCREMENTAL_ENABLED;
    const spy = jest.spyOn(scheduler, 'runOnce');
    await scheduler.tick();
    expect(spy).not.toHaveBeenCalled();
  });

  it('tick с ENV=1, но без ARCHIVE_DATABASE_URL → warn + no-op', async () => {
    process.env.TACTIC_DRILL_INCREMENTAL_ENABLED = '1';
    delete process.env.ARCHIVE_DATABASE_URL;
    const spy = jest.spyOn(scheduler, 'runOnce');
    await scheduler.tick();
    expect(spy).not.toHaveBeenCalled();
  });

  it('lock-защита: второй вызов tick во время running → skip', async () => {
    process.env.TACTIC_DRILL_INCREMENTAL_ENABLED = '1';
    process.env.ARCHIVE_DATABASE_URL = 'postgresql://dummy';
    let resolveRun!: () => void;
    const slowRunOnce = jest.spyOn(scheduler, 'runOnce').mockImplementation(
      () =>
        new Promise<{
          gamesProcessed: number;
          positionsScanned: number;
          drillsByType: Record<string, number>;
          insertedTotal: number;
          lastCursor: string | null;
          predicateDrops: {
            findForkUnsafeForker: number;
            findForkOverlap: number;
          };
        }>((resolve) => {
          resolveRun = () => resolve({
            gamesProcessed: 0,
            positionsScanned: 0,
            drillsByType: {} as Record<string, number>,
            insertedTotal: 0,
            lastCursor: null,
            // KS-2406 / KS-2408: scheduler логирует эти поля;
            // stub без них приводит к runtime-ошибке в tick().
            predicateDrops: {
              findForkUnsafeForker: 0,
              findForkOverlap: 0,
            },
          });
        }),
    );

    const t1 = scheduler.tick();
    // Второй вызов до завершения первого должен быть пропущен.
    const t2 = scheduler.tick();
    resolveRun();
    await t1;
    await t2;

    // runOnce вызывался только один раз — lock сработал.
    expect(slowRunOnce).toHaveBeenCalledTimes(1);
  });

  it('resetCursor → redis.del', async () => {
    redis.store.set('tactic-drill:incremental:cursor', 'abc');
    await scheduler.resetCursor();
    expect(redis.del).toHaveBeenCalledWith('tactic-drill:incremental:cursor');
    expect(redis.store.has('tactic-drill:incremental:cursor')).toBe(false);
  });

  it('tick: ошибки runOnce ловятся и не падают cron', async () => {
    process.env.TACTIC_DRILL_INCREMENTAL_ENABLED = '1';
    process.env.ARCHIVE_DATABASE_URL = 'postgresql://dummy';
    jest
      .spyOn(scheduler, 'runOnce')
      .mockRejectedValue(new Error('archive db unreachable'));
    // Не должно бросить наружу.
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });
});
