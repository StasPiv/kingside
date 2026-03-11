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
        findMany: jest.fn().mockResolvedValue([]),
      },
      puzzleRushScore: {
        create: jest.fn().mockResolvedValue({ id: 'score-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
      },
      puzzleRushSessionPuzzle: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
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

    it('should auto-finish existing session and start new one', async () => {
      const oldSession = {
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
      // First get returns existing session, second returns null (after del)
      redis.get.mockResolvedValueOnce(JSON.stringify(oldSession)).mockResolvedValueOnce(null);

      const result = await service.startSession(userId, '3');

      expect(prisma.puzzleRushScore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId, score: 5 }),
        }),
      );
      expect(redis.del).toHaveBeenCalled();
      expect(result.durationMs).toBe(180000);
      expect(result.lives).toBe(3);
    });

    it('should auto-finish expired session with time reason', async () => {
      const expiredSession = {
        userId,
        timeMode: '3',
        score: 3,
        lives: 1,
        currentPuzzleId: 'puzzle-1',
        currentMoves: ['e7e5'],
        currentMoveIndex: 0,
        startedAt: Date.now() - 300000, // expired
        durationMs: 180000,
        solvedPuzzleIds: [],
      };
      redis.get.mockResolvedValueOnce(JSON.stringify(expiredSession)).mockResolvedValueOnce(null);

      const result = await service.startSession(userId, '3');

      expect(prisma.puzzleRushScore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId, score: 3 }),
        }),
      );
      expect(result.lives).toBe(3);
    });

    it('should force-delete stale session if auto-finish fails', async () => {
      redis.get.mockResolvedValueOnce('invalid-json').mockResolvedValueOnce(null);

      const result = await service.startSession(userId, '3');

      expect(redis.del).toHaveBeenCalledWith(`puzzle_rush:${userId}:session`);
      expect(result.durationMs).toBe(180000);
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
      sessionPuzzles: [],
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
    it('should return sorted leaderboard with unique users', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { userId: 'u1', username: 'player1', score: 15, createdAt: new Date() },
        { userId: 'u2', username: 'player2', score: 10, createdAt: new Date() },
      ]);

      const result = await service.getLeaderboard('3');

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].score).toBe(15);
      expect(result.entries[0].username).toBe('player1');
    });

    it('should return empty entries when no scores', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await service.getLeaderboard('3');

      expect(result.entries).toHaveLength(0);
    });

    it('should call $queryRaw for leaderboard', async () => {
      await service.getLeaderboard('3');

      expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it('should throw BadRequestException for invalid time mode', async () => {
      await expect(service.getLeaderboard('10')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.getLeaderboard('10')).rejects.toMatchObject({
        response: expect.objectContaining({ errorCode: 'INVALID_TIME_MODE' }),
      });
    });
  });

  describe('submitAnswer — multi-move puzzles', () => {
    const makeMultiMoveSession = (overrides = {}) => ({
      userId,
      timeMode: '3',
      score: 0,
      lives: 3,
      currentPuzzleId: 'puzzle-multi',
      // 4 moves: user move, opponent response, user move, (done)
      currentMoves: ['e2e4', 'd7d5', 'e4d5', 'c7c6'],
      currentMoveIndex: 0,
      startedAt: Date.now(),
      durationMs: 180000,
      solvedPuzzleIds: [],
      sessionPuzzles: [],
      ...overrides,
    });

    it('should return opponent move on intermediate correct answer', async () => {
      redis.get.mockResolvedValue(JSON.stringify(makeMultiMoveSession()));
      prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1400 });

      const result = await service.submitAnswer(userId, 'e2e4');

      expect(result.correct).toBe(true);
      expect(result.finished).toBe(false);
      expect(result.nextPuzzle).toBeNull();
      // Should return opponent's response move
      expect(result.expectedMove).toBe('d7d5');
      // Score should NOT increment on intermediate move
      expect(result.score).toBe(0);
    });

    it('should increment score when final move of multi-move puzzle is correct', async () => {
      const session = makeMultiMoveSession({ currentMoveIndex: 2 });
      redis.get.mockResolvedValue(JSON.stringify(session));
      prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1400 });

      const result = await service.submitAnswer(userId, 'e4d5');

      expect(result.correct).toBe(true);
      expect(result.score).toBe(1);
      expect(result.finished).toBe(false);
      expect(result.nextPuzzle).toBeDefined();
    });

    it('should update currentMoveIndex in session after intermediate move', async () => {
      redis.get.mockResolvedValue(JSON.stringify(makeMultiMoveSession()));
      prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1400 });

      await service.submitAnswer(userId, 'e2e4');

      // Verify session was saved with updated moveIndex
      expect(redis.set).toHaveBeenCalled();
      const savedSession = JSON.parse(redis.set.mock.calls[0][1]);
      expect(savedSession.currentMoveIndex).toBe(2);
    });
  });

  describe('endSession', () => {
    it('should end session and save score to database', async () => {
      const session = {
        userId,
        timeMode: '3',
        score: 7,
        lives: 2,
        currentPuzzleId: 'puzzle-1',
        currentMoves: ['e7e5'],
        currentMoveIndex: 0,
        startedAt: Date.now() - 60000,
        durationMs: 180000,
        solvedPuzzleIds: ['p1', 'p2'],
        sessionPuzzles: [],
      };
      redis.get.mockResolvedValue(JSON.stringify(session));

      const result = await service.endSession(userId);

      expect(result.score).toBe(7);
      expect(result.timeMode).toBe('3');
      expect(prisma.puzzleRushScore.create).toHaveBeenCalledWith({
        data: {
          userId,
          score: 7,
          timeMode: '3',
        },
      });
      expect(redis.del).toHaveBeenCalled();
    });

    it('should throw NotFoundException when no session exists', async () => {
      redis.get.mockResolvedValue(null);

      await expect(service.endSession(userId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('submitAnswer — rating update (ELO)', () => {
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
      sessionPuzzles: [],
      ...overrides,
    });

    it('should record puzzle attempt and update user rating on correct answer', async () => {
      redis.get.mockResolvedValue(JSON.stringify(makeSession()));
      prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1400 });

      await service.submitAnswer(userId, 'e7e5');

      expect(prisma.puzzleAttempt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          puzzleId: 'puzzle-1',
          userId,
          solved: true,
          ratingBefore: 1500,
        }),
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { ratingPuzzle: expect.any(Number) },
      });
    });

    it('should record puzzle attempt on wrong answer', async () => {
      redis.get.mockResolvedValue(JSON.stringify(makeSession()));
      prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1400 });

      await service.submitAnswer(userId, 'a7a6');

      expect(prisma.puzzleAttempt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          puzzleId: 'puzzle-1',
          userId,
          solved: false,
        }),
      });
    });

    it('should increase rating when solving harder puzzle', async () => {
      redis.get.mockResolvedValue(JSON.stringify(makeSession()));
      // Puzzle rating higher than user rating
      prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1800 });

      await service.submitAnswer(userId, 'e7e5');

      const updateCall = prisma.user.update.mock.calls[0][0];
      // New rating should be higher than 1500 (user solved a harder puzzle)
      expect(updateCall.data.ratingPuzzle).toBeGreaterThan(1500);
    });

    it('should decrease rating when failing easier puzzle', async () => {
      redis.get.mockResolvedValue(JSON.stringify(makeSession()));
      // Puzzle rating lower than user rating
      prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1200 });

      await service.submitAnswer(userId, 'a7a6'); // wrong

      const updateCall = prisma.user.update.mock.calls[0][0];
      // New rating should be lower than 1500
      expect(updateCall.data.ratingPuzzle).toBeLessThan(1500);
    });
  });

  describe('getLeaderboard — custom limit', () => {
    it('should respect custom limit parameter', async () => {
      await service.getLeaderboard('5', 10);

      expect(prisma.$queryRaw).toHaveBeenCalled();
    });
  });

  describe('submitAnswer — no more puzzles available', () => {
    const makeSession = (overrides = {}) => ({
      userId,
      timeMode: '3',
      score: 5,
      lives: 3,
      currentPuzzleId: 'puzzle-1',
      currentMoves: ['e7e5', 'd2d4'],
      currentMoveIndex: 0,
      startedAt: Date.now(),
      durationMs: 180000,
      solvedPuzzleIds: [],
      sessionPuzzles: [],
      ...overrides,
    });

    it('should finish session when no more puzzles on correct answer', async () => {
      redis.get.mockResolvedValue(JSON.stringify(makeSession()));
      prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1400 });
      // Return empty for next puzzle search
      prisma.puzzle.findMany.mockResolvedValue([]);

      const result = await service.submitAnswer(userId, 'e7e5');

      expect(result.finished).toBe(true);
      expect(result.score).toBe(6);
    });

    it('should finish session when no more puzzles on wrong answer', async () => {
      redis.get.mockResolvedValue(JSON.stringify(makeSession()));
      prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1400 });
      prisma.puzzle.findMany.mockResolvedValue([]);

      const result = await service.submitAnswer(userId, 'a7a6');

      expect(result.finished).toBe(true);
    });
  });

  describe('getUserBest', () => {
    it('should return best score with metadata', async () => {
      const createdAt = new Date();
      prisma.puzzleRushScore.findFirst.mockResolvedValue({ score: 12, createdAt });

      const result = await service.getUserBest(userId, '3');

      expect(result.score).toBe(12);
      expect(result.timeMode).toBe('3');
      expect(result.createdAt).toBe(createdAt);
    });

    it('should return 0 score when no scores', async () => {
      prisma.puzzleRushScore.findFirst.mockResolvedValue(null);

      const result = await service.getUserBest(userId, '3');

      expect(result.score).toBe(0);
      expect(result.timeMode).toBe('3');
      expect(result.createdAt).toBeNull();
    });

    it('should throw BadRequestException for invalid time mode', async () => {
      await expect(service.getUserBest(userId, '10')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.getUserBest(userId, '10')).rejects.toMatchObject({
        response: expect.objectContaining({ errorCode: 'INVALID_TIME_MODE' }),
      });
    });
  });

  describe('KS-299: Puzzle Rush excludes all attempted puzzles', () => {
    it('should exclude previously attempted puzzles from getRandomPuzzle during session', async () => {
      // User has previously attempted puzzle-old-1 and puzzle-old-2
      prisma.puzzleAttempt = {
        ...prisma.puzzleAttempt,
        findMany: jest.fn().mockResolvedValue([
          { puzzleId: 'puzzle-old-1' },
          { puzzleId: 'puzzle-old-2' },
        ]),
      };

      const newPuzzle = {
        id: 'puzzle-new',
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moves: 'e2e4 e7e5',
        rating: 1400,
        ratingDeviation: 100,
      };
      prisma.puzzle.findMany.mockResolvedValue([newPuzzle]);

      const result = await service.startSession(userId, '3');

      // Verify puzzleAttempt.findMany was called without solved filter
      expect(prisma.puzzleAttempt.findMany).toHaveBeenCalledWith({
        where: { userId },
        select: { puzzleId: true },
        distinct: ['puzzleId'],
      });
      // Verify puzzle query excludes attempted IDs
      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { notIn: expect.arrayContaining(['puzzle-old-1', 'puzzle-old-2']) },
          }),
        }),
      );
      expect(result.puzzle).toBeDefined();
    });

    it('should combine session excludeIds with attempted puzzleIds', async () => {
      // Simulate: user solved puzzle-1 in current session, and previously attempted puzzle-old
      prisma.puzzleAttempt = {
        ...prisma.puzzleAttempt,
        findMany: jest.fn().mockResolvedValue([
          { puzzleId: 'puzzle-old' },
        ]),
      };
      const session = {
        userId,
        timeMode: '3',
        score: 1,
        lives: 3,
        currentPuzzleId: 'puzzle-1',
        currentMoves: ['e7e5', 'd2d4'],
        currentMoveIndex: 0,
        startedAt: Date.now(),
        durationMs: 180000,
        solvedPuzzleIds: ['puzzle-session-1'],
        sessionPuzzles: [],
      };
      redis.get.mockResolvedValue(JSON.stringify(session));
      prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1400 });
      const nextPuzzle = {
        id: 'puzzle-fresh',
        fen: 'fen-fresh',
        moves: 'a2a4 a7a5',
        rating: 1400,
        ratingDeviation: 100,
      };
      prisma.puzzle.findMany.mockResolvedValue([nextPuzzle]);

      const result = await service.submitAnswer(userId, 'e7e5');

      // After solving, getRandomPuzzle should exclude both session-solved AND previously attempted
      expect(prisma.puzzleAttempt.findMany).toHaveBeenCalledWith({
        where: { userId },
        select: { puzzleId: true },
        distinct: ['puzzleId'],
      });
      expect(prisma.puzzle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: {
              notIn: expect.arrayContaining(['puzzle-session-1', 'puzzle-1', 'puzzle-old']),
            },
          }),
        }),
      );
      expect(result.correct).toBe(true);
    });

    it('should finish session when all puzzles have been attempted', async () => {
      prisma.puzzleAttempt = {
        ...prisma.puzzleAttempt,
        findMany: jest.fn().mockResolvedValue([
          { puzzleId: 'p1' },
          { puzzleId: 'p2' },
          { puzzleId: 'p3' },
        ]),
      };
      const session = {
        userId,
        timeMode: '3',
        score: 3,
        lives: 3,
        currentPuzzleId: 'p4',
        currentMoves: ['e7e5', 'd2d4'],
        currentMoveIndex: 0,
        startedAt: Date.now(),
        durationMs: 180000,
        solvedPuzzleIds: ['p1', 'p2', 'p3'],
        sessionPuzzles: [],
      };
      redis.get.mockResolvedValue(JSON.stringify(session));
      prisma.puzzle.findUniqueOrThrow.mockResolvedValue({ rating: 1400 });
      // No puzzles left
      prisma.puzzle.findMany.mockResolvedValue([]);

      const result = await service.submitAnswer(userId, 'e7e5');

      expect(result.finished).toBe(true);
      expect(result.score).toBe(4);
    });
  });
});
