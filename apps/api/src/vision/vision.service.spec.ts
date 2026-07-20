/**
 * KS-4982 / ADR-167 §5 — unit-тесты VisionService.
 */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: jest.fn() }));

import { BadRequestException } from '@nestjs/common';
import { VisionService } from './vision.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { CacheService } from '../common/cache.service';
import type { VisionResult } from '@kingside/shared';

type Jf = jest.Mock;
interface MockPrisma {
  visionScore: { create: Jf; aggregate: Jf; groupBy: Jf; findMany: Jf };
  $queryRaw: Jf;
}
interface MockCache {
  getOrSet: Jf;
  invalidate: Jf;
}

describe('VisionService', () => {
  let service: VisionService;
  let prisma: MockPrisma;
  let cache: MockCache;

  const userId = '11111111-1111-4111-a111-111111111111';
  const base: VisionResult = {
    mode: 'color',
    timeMode: '60s',
    difficulty: 1,
    score: 8,
    total: 10,
    accuracy: 0.8,
    maxStreak: 5,
    avgResponseMs: 1200,
  };

  beforeEach(() => {
    prisma = {
      visionScore: {
        create: jest.fn().mockResolvedValue({ id: 'score-1' }),
        aggregate: jest.fn(),
        groupBy: jest.fn(),
        findMany: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    cache = {
      getOrSet: jest
        .fn()
        .mockImplementation((_k: string, _t: number, fn: () => Promise<unknown>) => fn()),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    service = new VisionService(
      prisma as unknown as PrismaService,
      cache as unknown as CacheService,
    );
  });

  describe('saveResult', () => {
    it('сохраняет итог авторизованного и пересчитывает accuracy', async () => {
      const res = await service.saveResult(userId, { ...base, accuracy: 0.99 });
      expect(res).toEqual({ saved: true, scoreId: 'score-1' });
      const arg = prisma.visionScore.create.mock.calls[0][0];
      expect(arg.data.userId).toBe(userId);
      expect(arg.data.accuracy).toBe(0.8); // 8/10, а не клиентские 0.99
      expect(cache.invalidate).toHaveBeenCalledWith(
        'cache:vision:leaderboard:color:60s:*',
      );
    });

    it('total<=0 → BadRequest', async () => {
      await expect(
        service.saveResult(userId, { ...base, total: 0, score: 0 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('score>total → BadRequest', async () => {
      await expect(
        service.saveResult(userId, { ...base, score: 11, total: 10 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('maxStreak>total → BadRequest', async () => {
      await expect(
        service.saveResult(userId, { ...base, maxStreak: 11 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('leaderboard', () => {
    it('невалидный mode → BadRequest', async () => {
      await expect(service.leaderboard('bogus', '60s')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('невалидный timeMode → BadRequest', async () => {
      await expect(service.leaderboard('color', '99s')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('валидный запрос кэшируется и возвращает entries', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          userId,
          username: 'alice',
          score: 20,
          accuracy: 0.9,
          createdAt: new Date('2026-07-20T10:00:00Z'),
        },
      ]);
      const res = await service.leaderboard('color', '60s', 10);
      expect(cache.getOrSet).toHaveBeenCalledWith(
        'cache:vision:leaderboard:color:60s:10',
        60,
        expect.any(Function),
      );
      expect(res.entries[0]).toMatchObject({
        userId,
        username: 'alice',
        mode: 'color',
        timeMode: '60s',
        score: 20,
      });
    });

    it('username null → Anonymous', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { userId, username: null, score: 5, accuracy: 0.5, createdAt: new Date() },
      ]);
      const res = await service.leaderboard('find', '30s', 5);
      expect(res.entries[0].username).toBe('Anonymous');
    });
  });

  describe('statsForUser', () => {
    it('маппит агрегаты и byMode', async () => {
      prisma.visionScore.aggregate.mockResolvedValue({
        _count: { _all: 3 },
        _max: { score: 20, maxStreak: 7 },
        _avg: { accuracy: 0.755, avgResponseMs: 1234.6 },
      });
      prisma.visionScore.groupBy.mockResolvedValue([
        { mode: 'color', _count: { _all: 2 }, _max: { score: 20 } },
        { mode: 'find', _count: { _all: 1 }, _max: { score: 10 } },
      ]);
      const res = await service.statsForUser(userId);
      expect(res.totalSessions).toBe(3);
      expect(res.bestScore).toBe(20);
      expect(res.avgAccuracy).toBe(0.755);
      expect(res.avgResponseMs).toBe(1235);
      expect(res.byMode[0]).toEqual({ mode: 'color', sessions: 2, bestScore: 20 });
    });
  });

  describe('historyForUser', () => {
    it('hasMore и nextCursor при limit+1', async () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({
        id: `id-${i}`,
        mode: 'color',
        timeMode: '60s',
        difficulty: 1,
        score: i,
        total: 10,
        accuracy: i / 10,
        maxStreak: i,
        avgResponseMs: 1000,
        createdAt: new Date(2026, 6, 20, 10, 0, i),
      }));
      prisma.visionScore.findMany.mockResolvedValue(rows);
      const res = await service.historyForUser(userId, 2);
      expect(res.items).toHaveLength(2);
      expect(res.hasMore).toBe(true);
      expect(res.nextCursor).toBeTruthy();
    });
  });
});
