/**
 * KS-2373: юнит-тесты UserNavStatsService.
 * KS-2809: агрегация legacy-ключей в групповые на чтении.
 */
import {
  UserNavStatsService,
  aggregateNavStats,
} from './user-nav-stats.service';
import type { PrismaService } from '../prisma/prisma.service';

function makePrisma() {
  return {
    userNavStat: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue(undefined),
  } as unknown as PrismaService & Record<string, never>;
}

describe('UserNavStatsService — KS-2373', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: UserNavStatsService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new UserNavStatsService(prisma as unknown as PrismaService);
  });

  describe('increment', () => {
    it('UPSERT user_nav_stats с whitelist-route', async () => {
      await svc.increment('user-1', 'drills');
      const calls = (prisma.$queryRawUnsafe as jest.Mock).mock.calls;
      expect(calls).toHaveLength(1);
      const [sql, userId, route, cutoff] = calls[0];
      expect(typeof sql).toBe('string');
      expect(sql).toContain('INSERT INTO user_nav_stats');
      expect(sql).toContain('ON CONFLICT (user_id, route)');
      expect(sql).toContain('count = user_nav_stats.count + 1');
      expect(userId).toBe('user-1');
      expect(route).toBe('drills');
      // Cooldown timestamp передаётся в формате ISO.
      expect(typeof cutoff).toBe('string');
      expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('getTop — KS-2809 (агрегация в группы)', () => {
    it('агрегирует legacy-ключи в группы', async () => {
      (prisma.userNavStat.findMany as jest.Mock).mockResolvedValue([
        { route: 'drills', count: 42 },
        { route: 'archive', count: 10 },
        { route: 'play', count: 3 },
        { route: 'puzzles', count: 5 },
        { route: 'workshop', count: 2 },
      ]);
      const r = await svc.getTop('user-1');
      // drills+puzzles → train (47), archive+workshop → analyze (12),
      // play → play (3). Top-3 по убыванию.
      expect(r).toEqual([
        { route: 'train', count: 47 },
        { route: 'analyze', count: 12 },
        { route: 'play', count: 3 },
      ]);
      // findMany без take — берём всё, limit применяется ПОСЛЕ агрегации.
      const callArg = (prisma.userNavStat.findMany as jest.Mock).mock.calls[0][0];
      expect(callArg).toEqual(
        expect.objectContaining({
          where: { userId: 'user-1' },
          orderBy: { count: 'desc' },
        }),
      );
      expect(callArg.take).toBeUndefined();
    });

    it('пустой результат БД → []', async () => {
      (prisma.userNavStat.findMany as jest.Mock).mockResolvedValue([]);
      const r = await svc.getTop('user-1');
      expect(r).toEqual([]);
    });
  });
});

describe('aggregateNavStats — KS-2809 / ADR-058 §5.3 T12', () => {
  it('SUM(puzzles + drills + precision + puzzle-rush + train) → train', () => {
    const r = aggregateNavStats(
      [
        { route: 'puzzles', count: 1 },
        { route: 'drills', count: 2 },
        { route: 'precision', count: 4 },
        { route: 'puzzle-rush', count: 8 },
        { route: 'train', count: 16 },
      ],
      10,
    );
    expect(r).toEqual([{ route: 'train', count: 31 }]);
  });

  it('SUM(workshop + archive + analyze) → analyze', () => {
    const r = aggregateNavStats(
      [
        { route: 'workshop', count: 5 },
        { route: 'archive', count: 7 },
        { route: 'analyze', count: 11 },
      ],
      10,
    );
    expect(r).toEqual([{ route: 'analyze', count: 23 }]);
  });

  it('SUM(tournaments + play) → play', () => {
    const r = aggregateNavStats(
      [
        { route: 'tournaments', count: 3 },
        { route: 'play', count: 4 },
      ],
      10,
    );
    expect(r).toEqual([{ route: 'play', count: 7 }]);
  });

  it('SUM(lessons + learn) → learn', () => {
    const r = aggregateNavStats(
      [
        { route: 'lessons', count: 6 },
        { route: 'learn', count: 9 },
      ],
      10,
    );
    expect(r).toEqual([{ route: 'learn', count: 15 }]);
  });

  it('broadcasts / profile не агрегируются и идут как есть', () => {
    const r = aggregateNavStats(
      [
        { route: 'broadcasts', count: 100 },
        { route: 'profile', count: 50 },
      ],
      10,
    );
    expect(r).toEqual([
      { route: 'broadcasts', count: 100 },
      { route: 'profile', count: 50 },
    ]);
  });

  it('неизвестный route в БД игнорируется (не ломает агрегацию)', () => {
    const r = aggregateNavStats(
      [
        { route: 'legacy-removed', count: 999 },
        { route: 'play', count: 1 },
      ],
      10,
    );
    expect(r).toEqual([{ route: 'play', count: 1 }]);
  });

  it('сортировка: по убыванию count, при равенстве — по алфавиту', () => {
    const r = aggregateNavStats(
      [
        { route: 'play', count: 5 },
        { route: 'lessons', count: 5 },
        { route: 'profile', count: 5 },
      ],
      10,
    );
    // Все равные → алфавит: learn, play, profile.
    expect(r).toEqual([
      { route: 'learn', count: 5 },
      { route: 'play', count: 5 },
      { route: 'profile', count: 5 },
    ]);
  });

  it('limit применяется ПОСЛЕ агрегации (default 3)', () => {
    const r = aggregateNavStats([
      { route: 'puzzles', count: 100 },
      { route: 'workshop', count: 90 },
      { route: 'play', count: 80 },
      { route: 'lessons', count: 70 },
      { route: 'broadcasts', count: 60 },
      { route: 'profile', count: 50 },
    ]);
    expect(r).toHaveLength(3);
    expect(r.map((i) => i.route)).toEqual(['train', 'analyze', 'play']);
  });

  it('limit clamp [1..20]', () => {
    const input = [{ route: 'play', count: 1 }];
    expect(aggregateNavStats(input, 0)).toHaveLength(1);
    expect(aggregateNavStats(input, 9999)).toHaveLength(1);
  });

  it('реалистичный микс legacy+group от смешанных клиентов', () => {
    // Пользователь юзал и PostV1 (puzzles, drills), и PostV2 (train).
    // На чтении всё схлопывается в group-views.
    const r = aggregateNavStats(
      [
        { route: 'puzzles', count: 10 },
        { route: 'drills', count: 7 },
        { route: 'train', count: 3 }, // от нового клиента
        { route: 'workshop', count: 4 },
        { route: 'archive', count: 2 },
        { route: 'broadcasts', count: 8 },
      ],
      10,
    );
    expect(r).toEqual([
      { route: 'train', count: 20 },
      { route: 'broadcasts', count: 8 },
      { route: 'analyze', count: 6 },
    ]);
  });
});
