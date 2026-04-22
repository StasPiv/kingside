/**
 * Integration test: PuzzleRushController + PuzzleController registered together.
 * Verifies that route ordering does not cause conflicts between
 * /puzzles/:id and /puzzle-rush/* endpoints.
 */
import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  ExecutionContext,
} from '@nestjs/common';
import request from 'supertest';
import { PuzzleRushController } from './puzzle-rush.controller';
import { PuzzleRushService } from './puzzle-rush.service';
import { PuzzleController } from '../puzzle/puzzle.controller';
import { PuzzleService } from '../puzzle/puzzle.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

describe('PuzzleRush + Puzzle route conflict test', () => {
  let app: INestApplication;

  const mockUserId = '11111111-1111-4111-a111-111111111111';

  const mockPuzzleRushService = {
    startSession: jest.fn().mockResolvedValue({ session: { id: '1' } }),
    getSession: jest.fn().mockResolvedValue({ score: 0 }),
    getNextPuzzle: jest.fn().mockResolvedValue({ puzzle: { id: 'p1' } }),
    submitAnswer: jest.fn().mockResolvedValue({ correct: true }),
    endSession: jest.fn().mockResolvedValue({ score: 5 }),
    getLeaderboard: jest.fn().mockResolvedValue({ entries: [] }),
    getUserBest: jest.fn().mockResolvedValue(0),
  };

  const mockPuzzleService = {
    findPuzzles: jest.fn().mockResolvedValue([]),
    getPuzzle: jest.fn().mockResolvedValue({ id: 'abc123', fen: '' }),
    getNextPuzzle: jest.fn().mockResolvedValue(null),
    getNextPuzzleByTheme: jest.fn().mockResolvedValue(null),
    getStats: jest.fn().mockResolvedValue({}),
    getUserAttempts: jest.fn().mockResolvedValue([]),
    submitAttempt: jest.fn().mockResolvedValue({}),
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PuzzleRushController, PuzzleController],
      providers: [
        { provide: PuzzleRushService, useValue: mockPuzzleRushService },
        { provide: PuzzleService, useValue: mockPuzzleService },
        { provide: PrismaService, useValue: {} },
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

  it('POST /puzzle-rush/start should hit PuzzleRushController, not PuzzleController', async () => {
    const res = await request(app.getHttpServer())
      .post('/puzzle-rush/start')
      .send({ timeMode: '3' });

    expect(res.status).toBe(201);
    expect(mockPuzzleRushService.startSession).toHaveBeenCalledWith(
      mockUserId,
      '3',
    );
    expect(mockPuzzleService.submitAttempt).not.toHaveBeenCalled();
  });

  it('GET /puzzle-rush/session should hit PuzzleRushController', async () => {
    const res = await request(app.getHttpServer()).get('/puzzle-rush/session');

    expect(res.status).toBe(200);
    expect(mockPuzzleRushService.getSession).toHaveBeenCalledWith(mockUserId);
  });

  it('GET /puzzles/:id should still work for regular puzzles', async () => {
    const res = await request(app.getHttpServer()).get('/puzzles/abc123');

    expect(res.status).toBe(200);
    expect(mockPuzzleService.getPuzzle).toHaveBeenCalledWith('abc123');
  });

  it('/puzzle-rush/* and /puzzles/:id should not interfere with each other', async () => {
    const rushRes = await request(app.getHttpServer())
      .get('/puzzle-rush/leaderboard');
    const puzzleRes = await request(app.getHttpServer())
      .get('/puzzles/abc123');

    expect(rushRes.status).toBe(200);
    expect(puzzleRes.status).toBe(200);
    expect(mockPuzzleRushService.getLeaderboard).toHaveBeenCalled();
    expect(mockPuzzleService.getPuzzle).toHaveBeenCalledWith('abc123');
  });
});
