/**
 * KS-4357 / ADR-136 §3.6. Юнит-тесты планировщика дневного снимка
 * рейтинга. Покрытие:
 *   * `previousUtcDayWindow` — границы прошедшего UTC-дня;
 *   * `runOnce` — нет активности → 0 upsert'ов;
 *   * `runOnce` — есть активность → upsert(rating/attempts/solved) с
 *     `(userId, snapshotDate)`;
 *   * `runOnce` — идемпотентность: повторный вызов делает тот же upsert
 *     (UNIQUE индекс обеспечит, но и наш код не падает);
 *   * `dailyTick` — лок занят → ранний выход без чтения БД.
 */
jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import {
  TacticRatingSnapshotScheduler,
  previousUtcDayWindow,
} from './tactic-rating-snapshot.scheduler';

const USER_A = '11111111-1111-4111-a111-111111111111';
const USER_B = '22222222-2222-4222-a222-222222222222';

function makePrisma() {
  return {
    tacticPuzzleAttempt: {
      groupBy: jest.fn(),
    },
    userTacticRating: {
      findMany: jest.fn(),
    },
    tacticRatingSnapshot: {
      upsert: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function makeRedis(acquire: 'OK' | null = 'OK') {
  return {
    set: jest.fn().mockResolvedValue(acquire),
  };
}

describe('previousUtcDayWindow', () => {
  it('03:10 UTC 2026-06-20 → from=2026-06-19 00:00, to=2026-06-20 00:00', () => {
    const w = previousUtcDayWindow(new Date('2026-06-20T03:10:00Z'));
    expect(w.from.toISOString()).toBe('2026-06-19T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-06-20T00:00:00.000Z');
    expect(w.snapshotDate.toISOString()).toBe('2026-06-19T00:00:00.000Z');
  });

  it('почти полночь — день вычисляется по UTC, не локальной TZ', () => {
    const w = previousUtcDayWindow(new Date('2026-06-20T23:59:00Z'));
    expect(w.snapshotDate.toISOString().slice(0, 10)).toBe('2026-06-19');
  });
});

describe('TacticRatingSnapshotScheduler.runOnce', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let redis: ReturnType<typeof makeRedis>;
  let svc: TacticRatingSnapshotScheduler;
  const now = new Date('2026-06-20T03:10:00Z');
  const expectedDate = new Date('2026-06-19T00:00:00Z');

  beforeEach(() => {
    prisma = makePrisma();
    redis = makeRedis();
    svc = new TacticRatingSnapshotScheduler(prisma as never, redis as never);
  });

  it('нет активности → 0 snapshot, без upsert', async () => {
    prisma.tacticPuzzleAttempt.groupBy.mockResolvedValueOnce([]);
    const r = await svc.runOnce(now);
    expect(r).toEqual({ users: 0, snapshots: 0 });
    expect(prisma.tacticRatingSnapshot.upsert).not.toHaveBeenCalled();
  });

  it('двое играли → upsert(rating, attempts, solved) на каждого', async () => {
    prisma.tacticPuzzleAttempt.groupBy
      // первый — все попытки
      .mockResolvedValueOnce([
        { userId: USER_A, _count: { _all: 5 } },
        { userId: USER_B, _count: { _all: 2 } },
      ])
      // второй — только solved
      .mockResolvedValueOnce([
        { userId: USER_A, _count: { _all: 4 } },
        { userId: USER_B, _count: { _all: 0 } },
      ]);
    prisma.userTacticRating.findMany.mockResolvedValueOnce([
      { userId: USER_A, rating: 1620 },
      { userId: USER_B, rating: 1480 },
    ]);

    const r = await svc.runOnce(now);
    expect(r).toEqual({ users: 2, snapshots: 2 });
    expect(prisma.tacticRatingSnapshot.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.tacticRatingSnapshot.upsert).toHaveBeenCalledWith({
      where: { userId_date: { userId: USER_A, date: expectedDate } },
      update: { rating: 1620, attempts: 5, solved: 4 },
      create: {
        userId: USER_A,
        date: expectedDate,
        rating: 1620,
        attempts: 5,
        solved: 4,
      },
    });
    expect(prisma.tacticRatingSnapshot.upsert).toHaveBeenCalledWith({
      where: { userId_date: { userId: USER_B, date: expectedDate } },
      update: { rating: 1480, attempts: 2, solved: 0 },
      create: {
        userId: USER_B,
        date: expectedDate,
        rating: 1480,
        attempts: 2,
        solved: 0,
      },
    });
  });

  it('user_tactic_ratings пуст → используется дефолт 1500', async () => {
    prisma.tacticPuzzleAttempt.groupBy
      .mockResolvedValueOnce([{ userId: USER_A, _count: { _all: 1 } }])
      .mockResolvedValueOnce([{ userId: USER_A, _count: { _all: 1 } }]);
    prisma.userTacticRating.findMany.mockResolvedValueOnce([]);
    await svc.runOnce(now);
    expect(prisma.tacticRatingSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ rating: 1500 }),
      }),
    );
  });

  it('upsert одного пользователя падает → остальные продолжаются', async () => {
    prisma.tacticPuzzleAttempt.groupBy
      .mockResolvedValueOnce([
        { userId: USER_A, _count: { _all: 1 } },
        { userId: USER_B, _count: { _all: 1 } },
      ])
      .mockResolvedValueOnce([]);
    prisma.userTacticRating.findMany.mockResolvedValueOnce([]);
    prisma.tacticRatingSnapshot.upsert
      .mockRejectedValueOnce(new Error('synthetic'))
      .mockResolvedValueOnce(undefined);
    const r = await svc.runOnce(now);
    expect(r).toEqual({ users: 2, snapshots: 1 });
  });

  it('идемпотентность: два прогона с тем же now — оба используют тот же ключ uniqueIndex (snapshotDate)', async () => {
    prisma.tacticPuzzleAttempt.groupBy.mockResolvedValue([
      { userId: USER_A, _count: { _all: 1 } },
    ]);
    prisma.userTacticRating.findMany.mockResolvedValue([
      { userId: USER_A, rating: 1500 },
    ]);
    await svc.runOnce(now);
    await svc.runOnce(now);
    expect(prisma.tacticRatingSnapshot.upsert).toHaveBeenCalledTimes(2);
    for (const c of prisma.tacticRatingSnapshot.upsert.mock.calls) {
      expect(c[0].where.userId_date.date).toEqual(expectedDate);
    }
  });
});

describe('TacticRatingSnapshotScheduler.dailyTick', () => {
  it('redis lock занят (NOT OK) → ранний выход, БД не дёргается', async () => {
    const prisma = makePrisma();
    const redis = makeRedis(null);
    const svc = new TacticRatingSnapshotScheduler(
      prisma as never,
      redis as never,
    );
    await svc.dailyTick();
    expect(prisma.tacticPuzzleAttempt.groupBy).not.toHaveBeenCalled();
  });

  it('redis lock получен → groupBy вызван', async () => {
    const prisma = makePrisma();
    const redis = makeRedis('OK');
    prisma.tacticPuzzleAttempt.groupBy.mockResolvedValue([]);
    const svc = new TacticRatingSnapshotScheduler(
      prisma as never,
      redis as never,
    );
    await svc.dailyTick();
    expect(prisma.tacticPuzzleAttempt.groupBy).toHaveBeenCalled();
  });
});
