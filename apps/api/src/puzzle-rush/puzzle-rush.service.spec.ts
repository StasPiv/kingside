jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));
jest.mock('../redis/redis.service', () => ({
  RedisService: jest.fn(),
}));

import { NotFoundException, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { PuzzleRushService } from './puzzle-rush.service';

describe('PuzzleRushService', () => {
  let service: PuzzleRushService;
  let prisma: any;
  let redis: any;

  const userId = '11111111-1111-4111-a111-111111111111';
  const mockPuzzle = {
    id: 'puzzle-1',
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    moves: 'e7e5 d2d4',
    rating: 1400,
    ratingDeviation: 100,
  };

  beforeEach(() => {
    prisma = {
      puzzle: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([mockPuzzle]),
        count: jest.fn().mockResolvedValue(100),
        findUniqueOrThrow: jest.fn(),
      },
      puzzleAttempt: {
        create: jest.fn(),
      },
      puzzleRushScore: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
      },
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ ratingPuzzle: 1500 }),
        update: jest.fn(),
      },
    };

    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    service = new PuzzleRushService(prisma, redis);
  });

  describe('startSession', () => {
    it('should start a new session with 3-minute mode', async () => {
      const result = await service.startSession(userId, '3');

      expect(result.durationMs).toBe(180000);
      expect(result.lives).toBe(3);
      expect(result.timeMode).toBe('3');
      expect(redis.set).toHaveBeenCalled();
    });

    it('should start a new session with 5-minute mode', async () => {
      const result = await service.startSession(userId, '5');

      expect(result.durationMs).toBe(300000);
    });

    it('should throw BadRequestException with SESSION_EXISTS errorCode if session already exists', async () => {
      redis.get.mockResolvedValue(JSON.stringify({ userId }));

      await expect(service.startSession(userId, '3')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.startSession(userId, '3')).rejects.toMatchObject({
        response: expect.objectContaining({ errorCode: 'SESSION_EXISTS' }),
      });
    });

    it('should throw BadRequestException with INVALID_TIME_MODE errorCode for invalid time mode', async () => {
      await expect(service.startSession(userId, '10')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.startSession(userId, '10')).rejects.toMatchObject({
        response: expect.objectContaining({ errorCode: 'INVALID_TIME_MODE' }),
      });
    });

    it('should throw NotFoundException with NO_PUZZLES errorCode when no puzzles available', async () => {
      prisma.puzzle.findMany.mockResolvedValue([]);

      await expect(service.startSession(userId, '3')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.startSession(userId, '3')).rejects.toMatchObject({
        response: expect.objectContaining({ errorCode: 'NO_PUZZLES' }),
      });
    });

    it('should throw InternalServerErrorException on Redis get failure', async () => {
      redis.get.mockRejectedValue(new Error('Redis connection refused'));

      await expect(service.startSession(userId, '3')).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException on Prisma failure', async () => {
      prisma.user.findUniqueOrThrow.mockRejectedValue(new Error('Prisma connection error'));

      await expect(service.startSession(userId, '3')).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException on Redis set failure', async () => {
      redis.set.mockRejectedValue(new Error('Redis write error'));

      await expect(service.startSession(userId, '3')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('submitAnswer', () => {
    const makeSession = (overrides = {}) => ({
      userId,
      timeMode: '3',
      score: 0,
      lives: 3,
      currentPuzzleId: 'puzzle-1',
      currentMoves: ['e7e5', 'd2d4'],
      currentMoveIndex: 0,
      startedAt: Date.now(),
      durationMs: 180000,
      solvedPuzzleIds: [],
      ...overrides,
    });

    it('should accept correct answer and increment score', async () => {
      redis.get.mockResolvedValue(JSON.stringify(makeSession()));
      prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1400 });

      const result = await service.submitAnswer(userId, 'e7e5');

      expect(result.correct).toBe(true);
      expect(result.score).toBe(1);
      expect(result.lives).toBe(3);
      expect(result.finished).toBe(false);
    });

    it('should decrement lives on wrong answer', async () => {
      redis.get.mockResolvedValue(JSON.stringify(makeSession()));
      prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1400 });

      const result = await service.submitAnswer(userId, 'a7a6'); // wrong move

      expect(result.correct).toBe(false);
      expect(result.lives).toBe(2);
      expect(result.expectedMove).toBe('e7e5');
    });

    it('should finish session when lives reach 0', async () => {
      const session = makeSession({ lives: 1 });
      redis.get.mockResolvedValue(JSON.stringify(session));
      prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1400 });

      const result = await service.submitAnswer(userId, 'wrong');

      expect(result.finished).toBe(true);
      expect(result.lives).toBe(0);
      expect(prisma.puzzleRushScore.create).toHaveBeenCalled();
    });

    it('should finish session when time expires', async () => {
      const session = makeSession({
        startedAt: Date.now() - 200000, // started 200s ago, duration 180s
      });
      redis.get.mockResolvedValue(JSON.stringify(session));

      const result = await service.submitAnswer(userId, 'e7e5');

      expect(result.finished).toBe(true);
    });

    it('should throw NotFoundException with SESSION_NOT_FOUND errorCode when no active session', async () => {
      redis.get.mockResolvedValue(null);

      await expect(service.submitAnswer(userId, 'e2e4')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.submitAnswer(userId, 'e2e4')).rejects.toMatchObject({
        response: expect.objectContaining({ errorCode: 'SESSION_NOT_FOUND' }),
      });
    });

    it('should throw InternalServerErrorException on Redis failure during loadSession', async () => {
      redis.get.mockRejectedValue(new Error('Redis connection refused'));

      await expect(service.submitAnswer(userId, 'e2e4')).rejects.toThrow(
        InternalServerErrorException,
      );
      await expect(service.submitAnswer(userId, 'e2e4')).rejects.toMatchObject({
        response: expect.objectContaining({ errorCode: 'INTERNAL_ERROR' }),
      });
    });

    it('should throw InternalServerErrorException on Redis failure during saveSession', async () => {
      const session = makeSession();
      redis.get.mockResolvedValue(JSON.stringify(session));
      prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1400 });
      // First set succeeds (loadSession), second fails (saveSession)
      redis.set.mockRejectedValue(new Error('Redis write error'));

      await expect(service.submitAnswer(userId, 'a7a6')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getSession', () => {
    it('should return current session state', async () => {
      const session = {
        userId,
        timeMode: '3',
        score: 5,
        lives: 2,
        currentPuzzleId: 'puzzle-1',
        currentMoves: ['e7e5'],
        currentMoveIndex: 0,
        startedAt: Date.now() - 60000,
        durationMs: 180000,
        solvedPuzzleIds: [],
      };
      redis.get.mockResolvedValue(JSON.stringify(session));
      prisma.puzzle.findUnique.mockResolvedValue(mockPuzzle);

      const result = await service.getSession(userId);

      expect(result.score).toBe(5);
      expect(result.lives).toBe(2);
      expect(result.timeMode).toBe('3');
      expect(result.elapsedMs).toBeGreaterThan(0);
      expect(result.puzzle).toEqual({ fen: mockPuzzle.fen, rating: mockPuzzle.rating });
    });

    it('should throw NotFoundException with SESSION_NOT_FOUND errorCode when no active session', async () => {
      redis.get.mockResolvedValue(null);

      await expect(service.getSession(userId)).rejects.toThrow(NotFoundException);
      await expect(service.getSession(userId)).rejects.toMatchObject({
        response: expect.objectContaining({ errorCode: 'SESSION_NOT_FOUND' }),
      });
    });
  });

  describe('getLeaderboard', () => {
    it('should return sorted leaderboard', async () => {
      prisma.puzzleRushScore.findMany.mockResolvedValue([
        { userId: 'u1', score: 15, createdAt: new Date(), user: { username: 'player1' } },
        { userId: 'u2', score: 10, createdAt: new Date(), user: { username: 'player2' } },
      ]);

      const result = await service.getLeaderboard('3');

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].score).toBe(15);
      expect(result.entries[0].username).toBe('player1');
    });

    it('should use default limit of 20', async () => {
      await service.getLeaderboard('3');

      expect(prisma.puzzleRushScore.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20 }),
      );
    });
  });

  describe('getUserBest', () => {
    it('should return best score', async () => {
      prisma.puzzleRushScore.findFirst.mockResolvedValue({ score: 12 });

      const result = await service.getUserBest(userId, '3');

      expect(result).toBe(12);
    });

    it('should return 0 when no scores', async () => {
      prisma.puzzleRushScore.findFirst.mockResolvedValue(null);

      const result = await service.getUserBest(userId, '3');

      expect(result).toBe(0);
    });
  });
});
