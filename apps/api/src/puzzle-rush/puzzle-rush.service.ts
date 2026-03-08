import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
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

  async startSession(userId: string, timeMode: string) {
    this.logger.log(`Starting Puzzle Rush session: userId=${userId}, timeMode=${timeMode}`);

    const existing = await this.redis.get(this.sessionKey(userId));
    if (existing) {
      this.logger.warn(`Session already exists for userId=${userId}`);
      throw new BadRequestException('Active Puzzle Rush session already exists');
    }

    const durationMs = TIME_MODES[timeMode];
    if (!durationMs) {
      this.logger.warn(`Invalid time mode: ${timeMode}, userId=${userId}`);
      throw new BadRequestException('Invalid time mode');
    }

    const puzzle = await this.getRandomPuzzle(userId, []);
    if (!puzzle) {
      this.logger.warn(`No puzzles available for userId=${userId}`);
      throw new NotFoundException('No puzzles available');
    }

    const moves = puzzle.moves.split(' ');
    // In Lichess puzzles, first move is the "setup" move (opponent's last move).
    // The puzzle position is AFTER the first move is played.
    // User moves start from index 1.

    const now = new Date();
    const timeLimitSec = durationMs / 1000;

    const session: PuzzleRushSession = {
      userId,
      timeMode,
      score: 0,
      lives: MAX_LIVES,
      currentPuzzleId: puzzle.id,
      currentMoves: moves,
      currentMoveIndex: 1,
      startedAt: Date.now(),
      durationMs,
      solvedPuzzleIds: [],
    };

    await this.redis.set(
      this.sessionKey(userId),
      JSON.stringify(session),
      'EX',
      timeLimitSec + 60, // TTL slightly longer than session
    );

    this.logger.log(
      `Puzzle Rush started for ${userId}: mode=${timeMode}, puzzleId=${puzzle.id}, rating=${puzzle.rating}`,
    );

    return {
      session: {
        id: userId,
        solved: 0,
        failed: 0,
        timeLimitSec,
        startedAt: now.toISOString(),
        finishedAt: null,
      },
      puzzle: {
        id: puzzle.id,
        fen: puzzle.fen,
        moves: puzzle.moves.split(' '),
        rating: puzzle.rating,
        themes: puzzle.themes.split(' ').filter(Boolean),
      },
    };
  }

  async getSession(userId: string): Promise<{
    score: number;
    lives: number;
    timeMode: string;
    elapsedMs: number;
    durationMs: number;
    puzzle: { fen: string } | null;
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
      puzzle: puzzle ? { fen: puzzle.fen } : null,
    };
  }

  /**
   * Get next puzzle for prefetching (no delay transition).
   * Returns the current puzzle from the active session.
   */
  async getNextPuzzle(userId: string): Promise<{
    puzzle: { id: string; fen: string; moves: string[]; rating: number };
    score: number;
    lives: number;
    elapsedMs: number;
    durationMs: number;
  }> {
    const session = await this.loadSession(userId);

    const elapsed = Date.now() - session.startedAt;
    if (elapsed >= session.durationMs) {
      await this.finishSession(session, 'time');
      throw new BadRequestException('Session has expired');
    }

    const puzzle = await this.prisma.puzzle.findUnique({
      where: { id: session.currentPuzzleId },
    });
    if (!puzzle) {
      throw new NotFoundException('Current puzzle not found');
    }

    return {
      puzzle: {
        id: puzzle.id,
        fen: puzzle.fen,
        moves: puzzle.moves.split(' '),
        rating: puzzle.rating,
      },
      score: session.score,
      lives: session.lives,
      elapsedMs: elapsed,
      durationMs: session.durationMs,
    };
  }

  async submitAnswer(userId: string, uci: string): Promise<{
    correct: boolean;
    score: number;
    lives: number;
    finished: boolean;
    nextPuzzle: { fen: string; setupMove: string; rating: number } | null;
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

      const nextMoves = nextPuzzle.moves.split(' ');
      session.currentPuzzleId = nextPuzzle.id;
      session.currentMoves = nextMoves;
      session.currentMoveIndex = 1;

      await this.saveSession(session);

      return {
        correct: true,
        score: session.score,
        lives: session.lives,
        finished: false,
        nextPuzzle: { fen: nextPuzzle.fen, setupMove: nextMoves[0], rating: nextPuzzle.rating },
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

    const nextMoves = nextPuzzle.moves.split(' ');
    session.currentPuzzleId = nextPuzzle.id;
    session.currentMoves = nextMoves;
    session.currentMoveIndex = 1;

    await this.saveSession(session);

    return {
      correct: false,
      score: session.score,
      lives: session.lives,
      finished: false,
      nextPuzzle: { fen: nextPuzzle.fen, setupMove: nextMoves[0], rating: nextPuzzle.rating },
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
    const raw = await this.redis.get(this.sessionKey(userId));
    if (!raw) {
      throw new NotFoundException('No active Puzzle Rush session');
    }
    return JSON.parse(raw);
  }

  private async saveSession(session: PuzzleRushSession): Promise<void> {
    const remaining = session.durationMs - (Date.now() - session.startedAt);
    const ttl = Math.max(Math.ceil(remaining / 1000) + 60, 60);
    await this.redis.set(
      this.sessionKey(session.userId),
      JSON.stringify(session),
      'EX',
      ttl,
    );
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
    await this.prisma.puzzleRushScore.create({
      data: {
        userId: session.userId,
        score: session.score,
        timeMode: session.timeMode,
      },
    });

    // Clean up Redis session
    await this.redis.del(this.sessionKey(session.userId));

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

    const where = {
      rating: { gte: minRating, lte: maxRating },
      id: excludeIds.length > 0 ? { notIn: excludeIds } : undefined,
    };

    const count = await this.prisma.puzzle.count({ where });

    if (count > 0) {
      const skip = Math.floor(Math.random() * count);
      const puzzle = await this.prisma.puzzle.findMany({
        where,
        take: 1,
        skip,
      });
      return puzzle[0] || null;
    }

    // Fallback: try without rating filter
    const fallbackWhere = {
      id: excludeIds.length > 0 ? { notIn: excludeIds } : undefined,
    };

    const fallbackCount = await this.prisma.puzzle.count({ where: fallbackWhere });
    if (fallbackCount === 0) {
      return null;
    }

    const fallbackSkip = Math.floor(Math.random() * fallbackCount);
    const fallback = await this.prisma.puzzle.findMany({
      where: fallbackWhere,
      take: 1,
      skip: fallbackSkip,
    });
    return fallback[0] || null;
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
