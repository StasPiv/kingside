/**
 * E2E integration tests for PuzzleRush HTTP layer.
 * Verifies controller routes, DTO validation, and auth guard
 * to catch contract mismatches between frontend and backend.
 *
 * Contract:
 *   POST /api/puzzles/rush       { timeLimitSec: 180 | 300 }
 *   POST /api/puzzles/rush/answer { uci: string }
 *   GET  /api/puzzles/rush/session
 *   GET  /api/puzzles/rush/next
 *   DELETE /api/puzzles/rush/session
 *   GET  /api/puzzles/rush/leaderboard?timeLimitSec=&limit=
 *   GET  /api/puzzles/rush/best?timeLimitSec=
 */
import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, ExecutionContext } from '@nestjs/common';
import request from 'supertest';
import { PuzzleRushController } from './puzzle-rush.controller';
import { PuzzleRushService } from './puzzle-rush.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

describe('PuzzleRush Controller E2E', () => {
  let app: INestApplication;

  const mockUserId = '11111111-1111-4111-a111-111111111111';

  const mockStartResponse = {
    session: {
      id: mockUserId,
      solved: 0,
      failed: 0,
      timeLimitSec: 180,
      startedAt: '2026-03-08T00:00:00.000Z',
      finishedAt: null,
    },
    puzzle: {
      id: 'puzzle-1',
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      moves: ['e7e5', 'd2d4'],
      rating: 1400,
      themes: ['opening'],
    },
  };

  const mockService = {
    startSession: jest.fn().mockResolvedValue(mockStartResponse),
    getSession: jest.fn().mockResolvedValue({ score: 0, lives: 3 }),
    getNextPuzzle: jest.fn().mockResolvedValue({ puzzle: { id: 'p1' } }),
    submitAnswer: jest.fn().mockResolvedValue({ correct: true }),
    endSession: jest.fn().mockResolvedValue({ score: 5 }),
    getLeaderboard: jest.fn().mockResolvedValue({ entries: [] }),
    getUserBest: jest.fn().mockResolvedValue(0),
  };

  const BASE = '/puzzles/rush';

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PuzzleRushController],
      providers: [
        { provide: PuzzleRushService, useValue: mockService },
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

  describe(`POST ${BASE}`, () => {
    it('should accept timeLimitSec 180', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}`)
        .send({ timeLimitSec: 180 });

      expect(res.status).toBe(201);
      expect(res.body).toEqual(mockStartResponse);
      expect(mockService.startSession).toHaveBeenCalledWith(mockUserId, 180);
    });

    it('should accept timeLimitSec 300', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}`)
        .send({ timeLimitSec: 300 });

      expect(res.status).toBe(201);
      expect(mockService.startSession).toHaveBeenCalledWith(mockUserId, 300);
    });

    it('should reject invalid timeLimitSec', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}`)
        .send({ timeLimitSec: 600 });

      expect(res.status).toBe(400);
      expect(mockService.startSession).not.toHaveBeenCalled();
    });

    it('should reject missing timeLimitSec', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}`)
        .send({});

      expect(res.status).toBe(400);
      expect(mockService.startSession).not.toHaveBeenCalled();
    });

    it('should reject old format (timeMode instead of timeLimitSec)', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}`)
        .send({ timeMode: '3' });

      expect(res.status).toBe(400);
      expect(mockService.startSession).not.toHaveBeenCalled();
    });

    it('should reject string timeLimitSec', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}`)
        .send({ timeLimitSec: '180' });

      expect(res.status).toBe(400);
      expect(mockService.startSession).not.toHaveBeenCalled();
    });
  });

  describe(`POST ${BASE}/answer`, () => {
    it('should accept valid UCI move', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/answer`)
        .send({ uci: 'e2e4' });

      expect(res.status).toBe(201);
      expect(mockService.submitAnswer).toHaveBeenCalledWith(mockUserId, 'e2e4');
    });

    it('should reject missing uci', async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/answer`)
        .send({});

      expect(res.status).toBe(400);
      expect(mockService.submitAnswer).not.toHaveBeenCalled();
    });
  });

  describe(`GET ${BASE}/session`, () => {
    it('should return session state', async () => {
      const res = await request(app.getHttpServer())
        .get(`${BASE}/session`);

      expect(res.status).toBe(200);
      expect(mockService.getSession).toHaveBeenCalledWith(mockUserId);
    });
  });

  describe(`GET ${BASE}/next`, () => {
    it('should return next puzzle', async () => {
      const res = await request(app.getHttpServer())
        .get(`${BASE}/next`);

      expect(res.status).toBe(200);
      expect(mockService.getNextPuzzle).toHaveBeenCalledWith(mockUserId);
    });
  });

  describe(`DELETE ${BASE}/session`, () => {
    it('should end session', async () => {
      const res = await request(app.getHttpServer())
        .delete(`${BASE}/session`);

      expect(res.status).toBe(200);
      expect(mockService.endSession).toHaveBeenCalledWith(mockUserId);
    });
  });

  describe(`GET ${BASE}/leaderboard`, () => {
    it('should return leaderboard with default params', async () => {
      const res = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard`);

      expect(res.status).toBe(200);
      expect(mockService.getLeaderboard).toHaveBeenCalledWith('3', 20);
    });

    it('should accept custom timeLimitSec and limit', async () => {
      const res = await request(app.getHttpServer())
        .get(`${BASE}/leaderboard?timeLimitSec=300&limit=10`);

      expect(res.status).toBe(200);
      expect(mockService.getLeaderboard).toHaveBeenCalledWith('5', 10);
    });
  });

  describe(`GET ${BASE}/best`, () => {
    it('should return user best score', async () => {
      const res = await request(app.getHttpServer())
        .get(`${BASE}/best`);

      expect(res.status).toBe(200);
      expect(mockService.getUserBest).toHaveBeenCalledWith(mockUserId, '3');
    });
  });

  describe('Route mismatch detection', () => {
    it('should NOT respond on old route /puzzle-rush/start', async () => {
      const res = await request(app.getHttpServer())
        .post('/puzzle-rush/start')
        .send({ timeLimitSec: 180 });

      expect(res.status).toBe(404);
    });

    it('should NOT respond on /puzzle-rush', async () => {
      const res = await request(app.getHttpServer())
        .post('/puzzle-rush')
        .send({ timeLimitSec: 180 });

      expect(res.status).toBe(404);
    });
  });

  describe('Auth guard', () => {
    let appNoAuth: INestApplication;

    beforeAll(async () => {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [PuzzleRushController],
        providers: [
          { provide: PuzzleRushService, useValue: mockService },
        ],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue({
          canActivate: () => false,
        })
        .compile();

      appNoAuth = module.createNestApplication();
      appNoAuth.useGlobalPipes(new ValidationPipe({ whitelist: true }));
      await appNoAuth.init();
    });

    afterAll(async () => {
      await appNoAuth.close();
    });

    it('should reject unauthenticated request', async () => {
      const res = await request(appNoAuth.getHttpServer())
        .post(`${BASE}`)
        .send({ timeLimitSec: 180 });

      expect(res.status).toBe(403);
    });
  });
});
