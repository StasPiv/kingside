/**
 * KS-241: Verification of KS-238 fix — leaderboard no longer requires auth.
 *
 * Fix: @UseGuards(JwtAuthGuard) moved from controller class level to
 * individual methods (start, getSession, solve, endSession, getUserBest).
 * getLeaderboard is now a public endpoint.
 *
 * Scenarios:
 *  1. GET /puzzle-rush/leaderboard without auth → 200 (no redirect)
 *  2. GET /puzzle-rush/leaderboard with auth → 200
 *  3. POST /puzzle-rush/start without auth → 403
 *  4. GET /puzzle-rush/session without auth → 403
 *  5. POST /puzzle-rush/solve without auth → 403
 *  6. DELETE /puzzle-rush/session without auth → 403
 *  7. GET /puzzle-rush/best without auth → 403
 *  8. GET /puzzle-rush/best with auth → 200 (returns user data)
 *  9. Leaderboard returns entries with correct structure and sorting
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

describe('KS-241: Verify KS-238 leaderboard auth fix', () => {
  const mockUserId = '11111111-1111-4111-a111-111111111111';
  const BASE = '/puzzle-rush';

  let appNoAuth: INestApplication;
  let appAuth: INestApplication;
  let prisma: any;
  let redis: any;

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

    // App WITHOUT auth (guard rejects all)
    const noAuthModule: TestingModule = await Test.createTestingModule({
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

    appNoAuth = noAuthModule.createNestApplication();
    appNoAuth.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await appNoAuth.init();

    // App WITH auth (guard approves, sets req.user)
    const authModule: TestingModule = await Test.createTestingModule({
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

    appAuth = authModule.createNestApplication();
    appAuth.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await appAuth.init();
  });

  afterAll(async () => {
    await appNoAuth.close();
    await appAuth.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([]);
  });

  // ── Scenario 1: Leaderboard WITHOUT auth → 200 (KS-238 core fix) ──

  describe('GET /puzzle-rush/leaderboard — public access (KS-238 fix)', () => {
    it('should return 200 without auth (no redirect to /lobby)', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { userId: 'u1', username: 'alice', score: 30, createdAt: new Date() },
      ]);

      const res = await request(appNoAuth.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
      expect(res.headers.location).toBeUndefined();
      expect(res.body.entries).toBeDefined();
    });

    it('should return leaderboard data without auth', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { userId: 'u1', username: 'alice', score: 25, createdAt: new Date('2026-03-01') },
        { userId: 'u2', username: 'bob', score: 18, createdAt: new Date('2026-03-02') },
      ]);

      const res = await request(appNoAuth.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(2);
      expect(res.body.entries[0].username).toBe('alice');
      expect(res.body.entries[1].username).toBe('bob');
    });
  });

  // ── Scenario 2: Leaderboard WITH auth → 200 ──────────────────────

  describe('GET /puzzle-rush/leaderboard — authenticated access', () => {
    it('should return 200 with auth', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await request(appAuth.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
    });
  });

  // ── Scenarios 3–7: Protected endpoints reject unauthenticated ─────

  describe('protected endpoints — require auth (guard on individual methods)', () => {
    it('POST /puzzle-rush/start without auth → 403', async () => {
      const res = await request(appNoAuth.getHttpServer())
        .post(`${BASE}/start`)
        .send({ timeLimitSec: 180 });

      expect(res.status).toBe(403);
    });

    it('GET /puzzle-rush/session without auth → 403', async () => {
      const res = await request(appNoAuth.getHttpServer())
        .get(`${BASE}/session`);

      expect(res.status).toBe(403);
    });

    it('POST /puzzle-rush/solve without auth → 403', async () => {
      const res = await request(appNoAuth.getHttpServer())
        .post(`${BASE}/solve`)
        .send({ uci: 'e2e4' });

      expect(res.status).toBe(403);
    });

    it('DELETE /puzzle-rush/session without auth → 403', async () => {
      const res = await request(appNoAuth.getHttpServer())
        .delete(`${BASE}/session`);

      expect(res.status).toBe(403);
    });

    it('GET /puzzle-rush/best without auth → 403', async () => {
      const res = await request(appNoAuth.getHttpServer())
        .get(`${BASE}/best?timeMode=3`);

      expect(res.status).toBe(403);
    });
  });

  // ── Scenario 8: getUserBest with auth → 200 ───────────────────────

  describe('GET /puzzle-rush/best — authenticated access', () => {
    it('should return user best score for authenticated user', async () => {
      prisma.puzzleRushScore.findFirst.mockResolvedValue({
        score: 22,
        createdAt: new Date('2026-03-05T12:00:00.000Z'),
      });

      const res = await request(appAuth.getHttpServer())
        .get(`${BASE}/best?timeMode=3`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('score', 22);
      expect(res.body).toHaveProperty('timeMode', '3');
      expect(res.body).toHaveProperty('createdAt');
    });
  });

  // ── Scenario 9: Leaderboard data structure and sorting ────────────

  describe('leaderboard data integrity', () => {
    it('should return entries sorted by score DESC', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { userId: 'u1', username: 'top', score: 50, createdAt: new Date() },
        { userId: 'u2', username: 'mid', score: 30, createdAt: new Date() },
        { userId: 'u3', username: 'low', score: 10, createdAt: new Date() },
      ]);

      const res = await request(appNoAuth.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
      const scores = res.body.entries.map((e: any) => e.score);
      expect(scores).toEqual([50, 30, 10]);
    });

    it('should include userId, username, score, createdAt per entry', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { userId: 'u1', username: 'player1', score: 42, createdAt: new Date('2026-03-08') },
      ]);

      const res = await request(appNoAuth.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
      const entry = res.body.entries[0];
      expect(entry).toHaveProperty('userId');
      expect(entry).toHaveProperty('username');
      expect(entry).toHaveProperty('score');
      expect(entry).toHaveProperty('createdAt');
    });

    it('should handle empty leaderboard', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await request(appNoAuth.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(0);
    });
  });
});
