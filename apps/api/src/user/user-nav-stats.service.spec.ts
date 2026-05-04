/**
 * KS-2373: юнит-тесты UserNavStatsService.
 */
import { UserNavStatsService } from './user-nav-stats.service';
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

  describe('getTop', () => {
    it('возвращает items по убыванию count, default limit=3', async () => {
      (prisma.userNavStat.findMany as jest.Mock).mockResolvedValue([
        { route: 'drills', count: 42 },
        { route: 'archive', count: 10 },
        { route: 'play', count: 3 },
      ]);
      const r = await svc.getTop('user-1');
      expect(r).toEqual([
        { route: 'drills', count: 42 },
        { route: 'archive', count: 10 },
        { route: 'play', count: 3 },
      ]);
      expect(prisma.userNavStat.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1' },
          orderBy: { count: 'desc' },
          take: 3,
        }),
      );
    });

    it('limit clamped до 20', async () => {
      (prisma.userNavStat.findMany as jest.Mock).mockResolvedValue([]);
      await svc.getTop('user-1', 9999);
      expect(prisma.userNavStat.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20 }),
      );
    });

    it('limit min 1', async () => {
      (prisma.userNavStat.findMany as jest.Mock).mockResolvedValue([]);
      await svc.getTop('user-1', 0);
      expect(prisma.userNavStat.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 1 }),
      );
    });
  });
});
