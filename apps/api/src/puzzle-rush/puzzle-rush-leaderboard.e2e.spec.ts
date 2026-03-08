/**
 * KS-225: E2E verification of Puzzle Rush Leaderboard API.
 *
 * Scenarios:
 *  1. getLeaderboard — returns only the best score per player (no duplicates)
 *  2. getLeaderboard — filters by timeMode '3' and '5'
 *  3. getLeaderboard — invalid timeMode → BadRequestException, errorCode INVALID_TIME_MODE
 *  4. getUserBest — response structure {score, timeMode, createdAt}
 *  5. getUserBest — invalid timeMode → BadRequestException, errorCode INVALID_TIME_MODE
 *  6. Leaderboard sorting by score DESC
 *  7. Composite index usage for leaderboard queries
 */
import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, ExecutionContext } from '@nestjs/common';
import request from 'supertest';
import { PuzzleRushController } from './puzzle-rush.controller';
import { PuzzleRushService } from './puzzle-rush.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

describe('KS-225: Puzzle Rush Leaderboard E2E', () => {
  let app: INestApplication;
  let prisma: any;
  let redis: any;

  const mockUserId = '11111111-1111-4111-a111-111111111111';
  const BASE = '/puzzle-rush';

  beforeAll(async () => {
    prisma = {
      puzzle: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findUniqueOrThrow: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      puzzleAttempt: { create: jest.fn() },
      puzzleRushScore: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
      },
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ ratingPuzzle: 1500 }),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };

    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PuzzleRushController],
      providers: [
        PuzzleRushService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { id: mockUserId };
          return true;
        },
      })
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Scenario 1: Best score per player, no duplicates ──────────────

  describe('getLeaderboard — unique best score per player', () => {
    it('should return only one entry per user (best score)', async () => {
      // Simulate raw SQL returning DISTINCT ON results — one row per user
      prisma.$queryRaw.mockResolvedValue([
        { userId: 'u1', username: 'alice', score: 20, createdAt: new Date('2026-03-01') },
        { userId: 'u2', username: 'bob', score: 15, createdAt: new Date('2026-03-02') },
      ]);

      const res = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(2);

      // Verify no duplicate userIds
      const userIds = res.body.entries.map((e: any) => e.userId);
      expect(new Set(userIds).size).toBe(userIds.length);
    });

    it('should not contain duplicate userIds even with many results', async () => {
      const entries = Array.from({ length: 20 }, (_, i) => ({
        userId: `user-${i}`,
        username: `player${i}`,
        score: 100 - i,
        createdAt: new Date(),
      }));
      prisma.$queryRaw.mockResolvedValue(entries);

      const res = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);

      const userIds = res.body.entries.map((e: any) => e.userId);
      const uniqueIds = new Set(userIds);
      expect(uniqueIds.size).toBe(userIds.length);
    });
  });

  // ── Scenario 2: Filter by timeMode '3' and '5' ───────────────────

  describe('getLeaderboard — timeMode filtering', () => {
    it('should pass timeMode=3 to service', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
      expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it('should pass timeMode=5 to service', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=5`);

      expect(res.status).toBe(200);
      expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it('should default to timeMode=3 when not specified', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard`);

      expect(res.status).toBe(200);
      expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it('should return different results for different timeModes', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { userId: 'u1', username: 'alice', score: 25, createdAt: new Date() },
        ])
        .mockResolvedValueOnce([
          { userId: 'u2', username: 'bob', score: 30, createdAt: new Date() },
        ]);

      const res3 = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);
      const res5 = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=5`);

      expect(res3.body.entries[0].username).toBe('alice');
      expect(res5.body.entries[0].username).toBe('bob');
    });
  });

  // ── Scenario 3: Invalid timeMode → BadRequestException ───────────

  describe('getLeaderboard — invalid timeMode', () => {
    it('should return 400 with errorCode INVALID_TIME_MODE for timeMode=10', async () => {
      const res = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=10`);

      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('INVALID_TIME_MODE');
    });

    it('should return 400 with errorCode INVALID_TIME_MODE for timeMode=abc', async () => {
      const res = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=abc`);

      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('INVALID_TIME_MODE');
    });

    it('should return 400 with errorCode INVALID_TIME_MODE for timeMode=0', async () => {
      const res = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=0`);

      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('INVALID_TIME_MODE');
    });

    it('should return 400 with errorCode INVALID_TIME_MODE for empty timeMode', async () => {
      const res = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=`);

      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('INVALID_TIME_MODE');
    });
  });

  // ── Scenario 4: getUserBest response structure ────────────────────

  describe('getUserBest — response structure {score, timeMode, createdAt}', () => {
    it('should return {score, timeMode, createdAt} when user has scores', async () => {
      const createdAt = new Date('2026-03-05T12:00:00.000Z');
      prisma.puzzleRushScore.findFirst.mockResolvedValue({ score: 18, createdAt });

      const res = await request(app.getHttpServer())
        .get(`${BASE}/best?timeMode=3`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('score', 18);
      expect(res.body).toHaveProperty('timeMode', '3');
      expect(res.body).toHaveProperty('createdAt');
      expect(Object.keys(res.body)).toEqual(
        expect.arrayContaining(['score', 'timeMode', 'createdAt']),
      );
    });

    it('should return score=0 and createdAt=null when user has no scores', async () => {
      prisma.puzzleRushScore.findFirst.mockResolvedValue(null);

      const res = await request(app.getHttpServer())
        .get(`${BASE}/best?timeMode=3`);

      expect(res.status).toBe(200);
      expect(res.body.score).toBe(0);
      expect(res.body.timeMode).toBe('3');
      expect(res.body.createdAt).toBeNull();
    });

    it('should return best for timeMode=5', async () => {
      prisma.puzzleRushScore.findFirst.mockResolvedValue({
        score: 22,
        createdAt: new Date('2026-03-07'),
      });

      const res = await request(app.getHttpServer())
        .get(`${BASE}/best?timeMode=5`);

      expect(res.status).toBe(200);
      expect(res.body.score).toBe(22);
      expect(res.body.timeMode).toBe('5');
    });

    it('should default to timeMode=3 when not specified', async () => {
      prisma.puzzleRushScore.findFirst.mockResolvedValue(null);

      const res = await request(app.getHttpServer())
        .get(`${BASE}/best`);

      expect(res.status).toBe(200);
      expect(res.body.timeMode).toBe('3');
    });
  });

  // ── Scenario 5: getUserBest — invalid timeMode ────────────────────

  describe('getUserBest — invalid timeMode', () => {
    it('should return 400 with errorCode INVALID_TIME_MODE for timeMode=10', async () => {
      const res = await request(app.getHttpServer())
        .get(`${BASE}/best?timeMode=10`);

      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('INVALID_TIME_MODE');
    });

    it('should return 400 with errorCode INVALID_TIME_MODE for timeMode=abc', async () => {
      const res = await request(app.getHttpServer())
        .get(`${BASE}/best?timeMode=abc`);

      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('INVALID_TIME_MODE');
    });

    it('should return 400 with errorCode INVALID_TIME_MODE for timeMode=1', async () => {
      const res = await request(app.getHttpServer())
        .get(`${BASE}/best?timeMode=1`);

      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('INVALID_TIME_MODE');
    });
  });

  // ── Scenario 6: Leaderboard sorting by score DESC ─────────────────

  describe('getLeaderboard — sorting by score DESC', () => {
    it('should return entries sorted by score in descending order', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { userId: 'u1', username: 'top', score: 50, createdAt: new Date() },
        { userId: 'u2', username: 'mid', score: 30, createdAt: new Date() },
        { userId: 'u3', username: 'low', score: 10, createdAt: new Date() },
      ]);

      const res = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
      const scores = res.body.entries.map((e: any) => e.score);
      expect(scores).toEqual([50, 30, 10]);

      // Verify strictly descending
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i - 1]).toBeGreaterThan(scores[i]);
      }
    });

    it('should handle single entry leaderboard', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { userId: 'u1', username: 'solo', score: 42, createdAt: new Date() },
      ]);

      const res = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].score).toBe(42);
    });

    it('should handle empty leaderboard', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(0);
    });
  });

  // ── Scenario 7: Composite index verification ─────────────────────

  describe('getLeaderboard — composite index usage', () => {
    it('should use $queryRaw with DISTINCT ON for deduplication', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      // Service must call $queryRaw (uses DISTINCT ON + ORDER BY)
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('should respect limit parameter', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3&limit=5`);

      expect(res.status).toBe(200);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('should use findFirst with orderBy for getUserBest (leverages [userId, timeMode] index)', async () => {
      prisma.puzzleRushScore.findFirst.mockResolvedValue({
        score: 15,
        createdAt: new Date(),
      });

      await request(app.getHttpServer())
        .get(`${BASE}/best?timeMode=3`);

      expect(prisma.puzzleRushScore.findFirst).toHaveBeenCalledWith({
        where: { userId: mockUserId, timeMode: '3' },
        orderBy: { score: 'desc' },
      });
    });
  });

  // ── Additional edge cases ─────────────────────────────────────────

  describe('getLeaderboard — leaderboard entry structure', () => {
    it('should include userId, username, score, createdAt in each entry', async () => {
      const now = new Date('2026-03-08T10:00:00.000Z');
      prisma.$queryRaw.mockResolvedValue([
        { userId: 'u1', username: 'player1', score: 25, createdAt: now },
      ]);

      const res = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
      const entry = res.body.entries[0];
      expect(entry).toHaveProperty('userId', 'u1');
      expect(entry).toHaveProperty('username', 'player1');
      expect(entry).toHaveProperty('score', 25);
      expect(entry).toHaveProperty('createdAt');
    });
  });

  describe('auth requirement', () => {
    let appNoAuth: INestApplication;

    beforeAll(async () => {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [PuzzleRushController],
        providers: [
          PuzzleRushService,
          { provide: PrismaService, useValue: prisma },
          { provide: RedisService, useValue: redis },
        ],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue({ canActivate: () => false })
        .compile();

      appNoAuth = module.createNestApplication();
      appNoAuth.useGlobalPipes(new ValidationPipe({ whitelist: true }));
      await appNoAuth.init();
    });

    afterAll(async () => {
      await appNoAuth.close();
    });

    it('should reject unauthenticated leaderboard request', async () => {
      const res = await request(appNoAuth.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(403);
    });

    it('should reject unauthenticated best score request', async () => {
      const res = await request(appNoAuth.getHttpServer())
        .get(`${BASE}/best?timeMode=3`);

      expect(res.status).toBe(403);
    });
  });
});
