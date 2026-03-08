import { Injectable, Logger, NotFoundException, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

interface PuzzleRushSession {
  userId: string;
  timeMode: string;
  score: number;
  lives: number;
  currentPuzzleId: string;
  currentMoves: string[];
  currentMoveIndex: number;
  startedAt: number;
  durationMs: number;
  solvedPuzzleIds: string[];
}

const MAX_LIVES = 3;
const TIME_MODES: Record<string, number> = {
  '3': 3 * 60 * 1000,
  '5': 5 * 60 * 1000,
};

@Injectable()
export class PuzzleRushService {
  private readonly logger = new Logger(PuzzleRushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  private sessionKey(userId: string): string {
    return `puzzle_rush:${userId}:session`;
  }

  async startSession(userId: string, timeMode: string): Promise<{
    sessionId: string;
    puzzle: { fen: string; rating: number };
    timeMode: string;
    durationMs: number;
    lives: number;
  }> {
    this.logger.log(`startSession called: userId=${userId}, timeMode=${timeMode}`);

    let existing: string | null;
    try {
      existing = await this.redis.get(this.sessionKey(userId));
    } catch (error: any) {
      this.logger.error(`Redis error checking existing session for user ${userId}`, error?.stack || error);
      throw new InternalServerErrorException({
        message: 'Failed to check existing session',
        errorCode: 'INTERNAL_ERROR',
      });
    }

    if (existing) {
      this.logger.warn(`Session already exists for user ${userId}`);
      throw new BadRequestException({
        message: 'Active Puzzle Rush session already exists',
        errorCode: 'SESSION_EXISTS',
      });
    }

    const durationMs = TIME_MODES[timeMode];
    if (!durationMs) {
      this.logger.warn(`Invalid time mode "${timeMode}" requested by user ${userId}`);
      throw new BadRequestException({
        message: 'Invalid time mode',
        errorCode: 'INVALID_TIME_MODE',
      });
    }

    let puzzle: Awaited<ReturnType<typeof this.getRandomPuzzle>>;
    try {
      puzzle = await this.getRandomPuzzle(userId, []);
    } catch (error: any) {
      this.logger.error(`Prisma error fetching puzzle for user ${userId}`, error?.stack || error);
      throw new InternalServerErrorException({
        message: 'Failed to load puzzle',
        errorCode: 'INTERNAL_ERROR',
      });
    }

    if (!puzzle) {
      this.logger.warn(`No puzzles available for user ${userId}`);
      throw new NotFoundException({
        message: 'No puzzles available',
        errorCode: 'NO_PUZZLES',
      });
    }

    const moves = puzzle.moves.split(' ');
    // In Lichess puzzles, first move is the "setup" move (opponent's last move).
    // The puzzle position is AFTER the first move is played.
    const setupFen = puzzle.fen;

    const session: PuzzleRushSession = {
      userId,
      timeMode,
      score: 0,
      lives: MAX_LIVES,
      currentPuzzleId: puzzle.id,
      currentMoves: moves,
      currentMoveIndex: 0,
      startedAt: Date.now(),
      durationMs,
      solvedPuzzleIds: [],
    };

    try {
      await this.redis.set(
        this.sessionKey(userId),
        JSON.stringify(session),
        'EX',
        durationMs / 1000 + 60, // TTL slightly longer than session
      );
    } catch (error: any) {
      this.logger.error(`Redis error saving session for user ${userId}`, error?.stack || error);
      throw new InternalServerErrorException({
        message: 'Failed to create session',
        errorCode: 'INTERNAL_ERROR',
      });
    }

    this.logger.log(`Session started: userId=${userId}, timeMode=${timeMode}, puzzleId=${puzzle.id}`);

    return {
      sessionId: userId,
      puzzle: { fen: setupFen, rating: puzzle.rating },
      timeMode,
      durationMs,
      lives: MAX_LIVES,
    };
  }

  async getSession(userId: string): Promise<{
    score: number;
    lives: number;
    timeMode: string;
    elapsedMs: number;
    durationMs: number;
    puzzle: { fen: string; rating: number } | null;
  }> {
    const session = await this.loadSession(userId);

    const puzzle = await this.prisma.puzzle.findUnique({
      where: { id: session.currentPuzzleId },
    });

    return {
      score: session.score,
      lives: session.lives,
      timeMode: session.timeMode,
      elapsedMs: Date.now() - session.startedAt,
      durationMs: session.durationMs,
      puzzle: puzzle ? { fen: puzzle.fen, rating: puzzle.rating } : null,
    };
  }

  async getNextPuzzle(userId: string): Promise<{
    fen: string;
    rating: number;
  }> {
    const session = await this.loadSession(userId);

    const puzzle = await this.prisma.puzzle.findUnique({
      where: { id: session.currentPuzzleId },
    });

    if (!puzzle) {
      throw new NotFoundException({
        message: 'Current puzzle not found',
        errorCode: 'PUZZLE_NOT_FOUND',
      });
    }

    return { fen: puzzle.fen, rating: puzzle.rating };
  }

  async submitAnswer(userId: string, uci: string): Promise<{
    correct: boolean;
    score: number;
    lives: number;
    finished: boolean;
    nextPuzzle: { fen: string; rating: number } | null;
    expectedMove?: string;
  }> {
    const session = await this.loadSession(userId);

    // Check time
    const elapsed = Date.now() - session.startedAt;
    if (elapsed >= session.durationMs) {
      return this.finishSession(session, 'time');
    }

    const expectedMove = session.currentMoves[session.currentMoveIndex];
    const correct = uci === expectedMove;

    if (correct) {
      // Check if there are more moves in this puzzle (puzzles can have multi-move solutions)
      const nextIndex = session.currentMoveIndex + 2; // +2 because opponent response is in between
      if (nextIndex < session.currentMoves.length) {
        // More moves in puzzle — send opponent's response move, wait for next user move
        session.currentMoveIndex = nextIndex;
        await this.saveSession(session);

        // The opponent's response move (currentMoveIndex + 1)
        const opponentMove = session.currentMoves[session.currentMoveIndex - 1];

        return {
          correct: true,
          score: session.score,
          lives: session.lives,
          finished: false,
          nextPuzzle: null,
          expectedMove: opponentMove, // opponent's intermediate move
        };
      }

      // Puzzle fully solved
      session.score++;
      session.solvedPuzzleIds.push(session.currentPuzzleId);

      // Record attempt
      await this.recordAttempt(userId, session.currentPuzzleId, true);

      // Get next puzzle
      const nextPuzzle = await this.getRandomPuzzle(userId, session.solvedPuzzleIds);
      if (!nextPuzzle) {
        return this.finishSession(session, 'no_puzzles');
      }

      session.currentPuzzleId = nextPuzzle.id;
      session.currentMoves = nextPuzzle.moves.split(' ');
      session.currentMoveIndex = 0;

      await this.saveSession(session);

      return {
        correct: true,
        score: session.score,
        lives: session.lives,
        finished: false,
        nextPuzzle: { fen: nextPuzzle.fen, rating: nextPuzzle.rating },
      };
    }

    // Wrong answer
    session.lives--;
    await this.recordAttempt(userId, session.currentPuzzleId, false);

    if (session.lives <= 0) {
      return this.finishSession(session, 'no_lives');
    }

    // Get next puzzle (skip current)
    session.solvedPuzzleIds.push(session.currentPuzzleId);
    const nextPuzzle = await this.getRandomPuzzle(userId, session.solvedPuzzleIds);
    if (!nextPuzzle) {
      return this.finishSession(session, 'no_puzzles');
    }

    session.currentPuzzleId = nextPuzzle.id;
    session.currentMoves = nextPuzzle.moves.split(' ');
    session.currentMoveIndex = 0;

    await this.saveSession(session);

    return {
      correct: false,
      score: session.score,
      lives: session.lives,
      finished: false,
      nextPuzzle: { fen: nextPuzzle.fen, rating: nextPuzzle.rating },
      expectedMove,
    };
  }

  async endSession(userId: string): Promise<{
    score: number;
    timeMode: string;
    isHighScore: boolean;
  }> {
    const session = await this.loadSession(userId);
    const result = await this.finishSession(session, 'manual');
    return {
      score: result.score,
      timeMode: session.timeMode,
      isHighScore: false, // Will be checked in finishSession
    };
  }

  async getLeaderboard(timeMode: string, limit = 20): Promise<{
    entries: { userId: string; username: string; score: number; createdAt: Date }[];
  }> {
    const scores = await this.prisma.puzzleRushScore.findMany({
      where: { timeMode },
      orderBy: { score: 'desc' },
      take: limit,
      include: {
        user: { select: { username: true } },
      },
    });

    return {
      entries: scores.map((s) => ({
        userId: s.userId,
        username: s.user.username,
        score: s.score,
        createdAt: s.createdAt,
      })),
    };
  }

  async getUserBest(userId: string, timeMode: string): Promise<number> {
    const best = await this.prisma.puzzleRushScore.findFirst({
      where: { userId, timeMode },
      orderBy: { score: 'desc' },
    });
    return best?.score ?? 0;
  }

  private async loadSession(userId: string): Promise<PuzzleRushSession> {
    let raw: string | null;
    try {
      raw = await this.redis.get(this.sessionKey(userId));
    } catch (error: any) {
      this.logger.error(`Redis error loading session for user ${userId}`, error?.stack || error);
      throw new InternalServerErrorException({
        message: 'Failed to load session',
        errorCode: 'INTERNAL_ERROR',
      });
    }
    if (!raw) {
      throw new NotFoundException({
        message: 'No active Puzzle Rush session',
        errorCode: 'SESSION_NOT_FOUND',
      });
    }
    return JSON.parse(raw);
  }

  private async saveSession(session: PuzzleRushSession): Promise<void> {
    const remaining = session.durationMs - (Date.now() - session.startedAt);
    const ttl = Math.max(Math.ceil(remaining / 1000) + 60, 60);
    try {
      await this.redis.set(
        this.sessionKey(session.userId),
        JSON.stringify(session),
        'EX',
        ttl,
      );
    } catch (error: any) {
      this.logger.error(`Redis error saving session for user ${session.userId}`, error?.stack || error);
      throw new InternalServerErrorException({
        message: 'Failed to save session',
        errorCode: 'INTERNAL_ERROR',
      });
    }
  }

  private async finishSession(
    session: PuzzleRushSession,
    _reason: string,
  ): Promise<{
    correct: boolean;
    score: number;
    lives: number;
    finished: boolean;
    nextPuzzle: null;
  }> {
    // Save score to DB
    try {
      await this.prisma.puzzleRushScore.create({
        data: {
          userId: session.userId,
          score: session.score,
          timeMode: session.timeMode,
        },
      });
    } catch (error: any) {
      this.logger.error(`DB error saving score for user ${session.userId}`, error?.stack || error);
      throw new InternalServerErrorException({
        message: 'Failed to save score',
        errorCode: 'INTERNAL_ERROR',
      });
    }

    // Clean up Redis session
    try {
      await this.redis.del(this.sessionKey(session.userId));
    } catch (error: any) {
      this.logger.error(`Redis error cleaning session for user ${session.userId}`, error?.stack || error);
      // Not throwing here — score is already saved, cleanup failure is non-critical
    }

    this.logger.log(
      `Puzzle Rush ended for ${session.userId}: score=${session.score}, mode=${session.timeMode}, reason=${_reason}`,
    );

    return {
      correct: false,
      score: session.score,
      lives: session.lives,
      finished: true,
      nextPuzzle: null,
    };
  }

  private async getRandomPuzzle(
    userId: string,
    excludeIds: string[],
  ) {
    // Get user's puzzle rating for appropriate difficulty
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { ratingPuzzle: true },
    });

    const ratingRange = 300;
    const minRating = user.ratingPuzzle - ratingRange;
    const maxRating = user.ratingPuzzle + ratingRange;

    // Use raw query for random selection with exclusion
    const puzzles = await this.prisma.puzzle.findMany({
      where: {
        rating: { gte: minRating, lte: maxRating },
        id: { notIn: excludeIds.length > 0 ? excludeIds : undefined },
      },
      take: 10,
      skip: Math.floor(Math.random() * 100),
    });

    if (puzzles.length === 0) {
      // Fallback: try without rating filter
      const fallback = await this.prisma.puzzle.findMany({
        where: {
          id: { notIn: excludeIds.length > 0 ? excludeIds : undefined },
        },
        take: 1,
        skip: Math.floor(Math.random() * 50),
      });
      return fallback[0] || null;
    }

    return puzzles[Math.floor(Math.random() * puzzles.length)];
  }

  private async recordAttempt(
    userId: string,
    puzzleId: string,
    solved: boolean,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { ratingPuzzle: true },
    });

    const puzzle = await this.prisma.puzzle.findUniqueOrThrow({
      where: { id: puzzleId },
      select: { rating: true },
    });

    const K = 32;
    const expected = 1 / (1 + Math.pow(10, (puzzle.rating - user.ratingPuzzle) / 400));
    const actual = solved ? 1 : 0;
    const newRating = Math.round(user.ratingPuzzle + K * (actual - expected));

    await Promise.all([
      this.prisma.puzzleAttempt.create({
        data: {
          puzzleId,
          userId,
          solved,
          timeMs: 0, // In rush mode, individual time not tracked
          ratingBefore: user.ratingPuzzle,
          ratingAfter: newRating,
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { ratingPuzzle: newRating },
      }),
    ]);
  }
}
