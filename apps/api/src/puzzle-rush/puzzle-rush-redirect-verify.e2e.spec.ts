/**
 * KS-244: Verification of KS-238 fix — /puzzle-rush/leaderboard
 * must NOT redirect to /lobby for unauthenticated users.
 *
 * Scenarios:
 *  1. GET /puzzle-rush/leaderboard without auth — 200, no redirect
 *  2. GET /puzzle-rush/leaderboard with auth — 200
 *  3. Protected endpoints (start, session, solve, best) still require auth
 *  4. Unauthenticated requests to protected endpoints return 403
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

describe('KS-244: Verify KS-238 leaderboard redirect fix', () => {
  const mockUserId = '11111111-1111-4111-a111-111111111111';
  const BASE = '/puzzle-rush';

  let prisma: any;
  let redis: any;

  beforeAll(() => {
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
        findFirst: jest.fn().mockResolvedValue(null),
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
  });

  // ── Scenario 1: Leaderboard without auth — must NOT redirect ──────

  describe('GET /puzzle-rush/leaderboard without auth', () => {
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

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should return 200 for unauthenticated leaderboard request', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await request(appNoAuth.getHttpServer())
        .get(`${BASE}/leaderboard`);

      expect(res.status).toBe(200);
    });

    it('should NOT redirect to /lobby (no 3xx status)', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await request(appNoAuth.getHttpServer())
        .get(`${BASE}/leaderboard`);

      // Must not be a 3xx redirect
      expect(res.status).toBeLessThan(300);
      expect(res.headers.location).toBeUndefined();
    });

    it('should return leaderboard data, not a redirect body', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { userId: 'u1', username: 'alice', score: 20, createdAt: new Date() },
      ]);

      const res = await request(appNoAuth.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('entries');
      expect(Array.isArray(res.body.entries)).toBe(true);
      expect(res.body.entries).toHaveLength(1);
    });

    it('should work with timeMode=5 without auth', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await request(appNoAuth.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=5`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('entries');
    });
  });

  // ── Scenario 2: Leaderboard with auth — should work ───────────────

  describe('GET /puzzle-rush/leaderboard with auth', () => {
    let appAuth: INestApplication;

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
        .useValue({
          canActivate: (ctx: ExecutionContext) => {
            const req = ctx.switchToHttp().getRequest();
            req.user = { id: mockUserId };
            return true;
          },
        })
        .compile();

      appAuth = module.createNestApplication();
      appAuth.useGlobalPipes(new ValidationPipe({ whitelist: true }));
      await appAuth.init();
    });

    afterAll(async () => {
      await appAuth.close();
    });

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should return 200 for authenticated leaderboard request', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await request(appAuth.getHttpServer())
        .get(`${BASE}/leaderboard`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('entries');
    });

    it('should return leaderboard entries for authenticated user', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { userId: 'u1', username: 'alice', score: 30, createdAt: new Date() },
        { userId: 'u2', username: 'bob', score: 15, createdAt: new Date() },
      ]);

      const res = await request(appAuth.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(2);
    });
  });

  // ── Scenario 3 & 4: Protected endpoints require auth ──────────────

  describe('Protected endpoints require auth', () => {
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

    it('POST /puzzle-rush/start should reject unauthenticated request', async () => {
      const res = await request(appNoAuth.getHttpServer())
        .post(`${BASE}/start`)
        .send({ timeMode: '3' });

      expect(res.status).toBe(403);
    });

    it('GET /puzzle-rush/session should reject unauthenticated request', async () => {
      const res = await request(appNoAuth.getHttpServer())
        .get(`${BASE}/session`);

      expect(res.status).toBe(403);
    });

    it('POST /puzzle-rush/solve should reject unauthenticated request', async () => {
      const res = await request(appNoAuth.getHttpServer())
        .post(`${BASE}/solve`)
        .send({ uci: 'e2e4' });

      expect(res.status).toBe(403);
    });

    it('DELETE /puzzle-rush/session should reject unauthenticated request', async () => {
      const res = await request(appNoAuth.getHttpServer())
        .delete(`${BASE}/session`);

      expect(res.status).toBe(403);
    });

    it('GET /puzzle-rush/best should reject unauthenticated request', async () => {
      const res = await request(appNoAuth.getHttpServer())
        .get(`${BASE}/best`);

      expect(res.status).toBe(403);
    });

    it('GET /puzzle-rush/leaderboard should remain public (not protected)', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await request(appNoAuth.getHttpServer())
        .get(`${BASE}/leaderboard`);

      expect(res.status).toBe(200);
    });
  });
});
