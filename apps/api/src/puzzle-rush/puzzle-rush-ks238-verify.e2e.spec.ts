import { CacheService } from '../common/cache.service';
/**
 * KS-242: E2E verification of KS-238 fix — puzzle-rush leaderboard public access.
 *
 * Context: GET /puzzle-rush/leaderboard was previously behind JwtAuthGuard (401 for
 * unauthenticated users). KS-238 made this endpoint public.
 *
 * Scenarios:
 *  1. GET /puzzle-rush/leaderboard without auth — 200, data returned
 *  2. GET /puzzle-rush/leaderboard with auth — 200, data returned
 *  3. Protected endpoints (start, session, solve, endSession, best) still require auth
 *  4. Leaderboard does not redirect or return 401/403
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

describe('KS-242: Verify KS-238 fix — leaderboard public access', () => {
  let appPublic: INestApplication;  // guard rejects (simulates no token)
  let appAuth: INestApplication;    // guard accepts (simulates valid token)
  let prisma: any;
  let redis: any;

  const mockUserId = '22222222-2222-4222-a222-222222222222';
  const BASE = '/puzzle-rush';

  const leaderboardEntries = [
    { userId: 'u1', username: 'alice', score: 20, createdAt: new Date('2026-03-01') },
    { userId: 'u2', username: 'bob', score: 15, createdAt: new Date('2026-03-02') },
  ];

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
      $queryRaw: jest.fn().mockResolvedValue(leaderboardEntries),
    };

    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    // App where guard REJECTS (unauthenticated)
    const moduleNoAuth: TestingModule = await Test.createTestingModule({
      controllers: [PuzzleRushController],
      providers: [
        PuzzleRushService,
        CacheService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => false })
      .compile();

    appPublic = moduleNoAuth.createNestApplication();
    appPublic.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await appPublic.init();

    // App where guard ACCEPTS (authenticated)
    const moduleAuth: TestingModule = await Test.createTestingModule({
      controllers: [PuzzleRushController],
      providers: [
        PuzzleRushService,
        CacheService,
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

    appAuth = moduleAuth.createNestApplication();
    appAuth.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await appAuth.init();
  });

  afterAll(async () => {
    await appPublic.close();
    await appAuth.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue(leaderboardEntries);
  });

  // ── Scenario 1: Leaderboard without auth returns 200 ──────────────

  describe('Scenario 1: leaderboard accessible without authentication', () => {
    it('GET /puzzle-rush/leaderboard returns 200 without auth', async () => {
      const res = await request(appPublic.getHttpServer())
        .get(`${BASE}/leaderboard`);

      expect(res.status).toBe(200);
    });

    it('returns leaderboard entries without auth', async () => {
      const res = await request(appPublic.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(2);
      expect(res.body.entries[0]).toHaveProperty('username', 'alice');
      expect(res.body.entries[1]).toHaveProperty('username', 'bob');
    });

    it('supports timeMode=5 without auth', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { userId: 'u3', username: 'charlie', score: 30, createdAt: new Date() },
      ]);

      const res = await request(appPublic.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=5`);

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(1);
    });

    it('does not return 401 or 403 for unauthenticated leaderboard request', async () => {
      const res = await request(appPublic.getHttpServer())
        .get(`${BASE}/leaderboard`);

      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // ── Scenario 2: Leaderboard with auth returns 200 ─────────────────

  describe('Scenario 2: leaderboard works with authentication', () => {
    it('GET /puzzle-rush/leaderboard returns 200 with auth', async () => {
      const res = await request(appAuth.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(2);
    });

    it('returns same data structure for authenticated users', async () => {
      const res = await request(appAuth.getHttpServer())
        .get(`${BASE}/leaderboard?timeMode=3`);

      expect(res.status).toBe(200);
      const entry = res.body.entries[0];
      expect(entry).toHaveProperty('userId');
      expect(entry).toHaveProperty('username');
      expect(entry).toHaveProperty('score');
      expect(entry).toHaveProperty('createdAt');
    });
  });

  // ── Scenario 3: Protected endpoints still require auth ────────────

  describe('Scenario 3: protected endpoints reject unauthenticated requests', () => {
    it('POST /puzzle-rush/start returns 403 without auth', async () => {
      const res = await request(appPublic.getHttpServer())
        .post(`${BASE}/start`)
        .send({ timeMode: '3' });

      expect(res.status).toBe(403);
    });

    it('GET /puzzle-rush/session returns 403 without auth', async () => {
      const res = await request(appPublic.getHttpServer())
        .get(`${BASE}/session`);

      expect(res.status).toBe(403);
    });

    it('POST /puzzle-rush/solve returns 403 without auth', async () => {
      const res = await request(appPublic.getHttpServer())
        .post(`${BASE}/solve`)
        .send({ uci: 'e2e4' });

      expect(res.status).toBe(403);
    });

    it('DELETE /puzzle-rush/session returns 403 without auth', async () => {
      const res = await request(appPublic.getHttpServer())
        .delete(`${BASE}/session`);

      expect(res.status).toBe(403);
    });

    it('GET /puzzle-rush/best returns 403 without auth', async () => {
      const res = await request(appPublic.getHttpServer())
        .get(`${BASE}/best?timeMode=3`);

      expect(res.status).toBe(403);
    });
  });

  // ── Scenario 4: No redirect behaviour at API level ────────────────

  describe('Scenario 4: leaderboard does not redirect', () => {
    it('unauthenticated leaderboard request returns 200 (not 3xx redirect)', async () => {
      const res = await request(appPublic.getHttpServer())
        .get(`${BASE}/leaderboard`)
        .redirects(0);

      expect(res.status).toBe(200);
      // Ensure no redirect (3xx)
      expect(res.status >= 300 && res.status < 400).toBe(false);
    });

    it('authenticated leaderboard request returns 200 (not 3xx redirect)', async () => {
      const res = await request(appAuth.getHttpServer())
        .get(`${BASE}/leaderboard`)
        .redirects(0);

      expect(res.status).toBe(200);
    });
  });
});
