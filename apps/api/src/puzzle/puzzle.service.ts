import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PuzzleRatingService } from './puzzle-rating.service';
import type { PuzzleAttemptResult, PuzzleStats } from '@kingside/shared';

@Injectable()
export class PuzzleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly puzzleRating: PuzzleRatingService,
  ) {}

  /**
   * Get a puzzle matching the user's current rating (±200 range).
   * Excludes puzzles the user has already attempted.
   */
  async getNextPuzzle(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { ratingPuzzle: true },
    });

    const range = 200;
    const minRating = user.ratingPuzzle - range;
    const maxRating = user.ratingPuzzle + range;

    const attemptedIds = await this.prisma.puzzleAttempt.findMany({
      where: { userId },
      select: { puzzleId: true },
    });
    const excludeIds = attemptedIds.map((a) => a.puzzleId);

    const puzzles = await this.prisma.puzzle.findMany({
      where: {
        rating: { gte: minRating, lte: maxRating },
        id: { notIn: excludeIds.length > 0 ? excludeIds : undefined },
      },
      take: 10,
      orderBy: { rating: 'asc' },
    });

    if (puzzles.length === 0) {
      // Fallback: widen search to any unsolved puzzle
      const fallback = await this.prisma.puzzle.findFirst({
        where: {
          id: { notIn: excludeIds.length > 0 ? excludeIds : undefined },
        },
        orderBy: { rating: 'asc' },
      });
      if (!fallback) {
        throw new NotFoundException('No puzzles available');
      }
      return this.formatPuzzle(fallback);
    }

    // Pick a random puzzle from the candidates
    const picked = puzzles[Math.floor(Math.random() * puzzles.length)];
    return this.formatPuzzle(picked);
  }

  /**
   * Submit an attempt for a puzzle and return the rating changes.
   */
  async submitAttempt(
    userId: string,
    puzzleId: string,
    solved: boolean,
    timeMs: number,
  ): Promise<PuzzleAttemptResult> {
    const puzzle = await this.prisma.puzzle.findUnique({
      where: { id: puzzleId },
    });
    if (!puzzle) {
      throw new NotFoundException('Puzzle not found');
    }

    const ratingChange = await this.puzzleRating.applyRatingChange(
      userId,
      puzzleId,
      solved,
    );

    await this.prisma.puzzleAttempt.create({
      data: {
        puzzleId,
        userId,
        solved,
        timeMs,
        ratingBefore: ratingChange.userRatingBefore,
        ratingAfter: ratingChange.userRatingAfter,
      },
    });

    return {
      solved,
      puzzleRating: ratingChange.puzzleRatingAfter,
      userRatingBefore: ratingChange.userRatingBefore,
      userRatingAfter: ratingChange.userRatingAfter,
      correctMoves: puzzle.moves.split(' '),
    };
  }

  /**
   * Get puzzle statistics for a user.
   */
  async getStats(userId: string): Promise<PuzzleStats> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { ratingPuzzle: true },
    });

    const [totalAttempted, totalSolved, bestRush] = await Promise.all([
      this.prisma.puzzleAttempt.count({ where: { userId } }),
      this.prisma.puzzleAttempt.count({ where: { userId, solved: true } }),
      this.prisma.puzzleRushSession.findFirst({
        where: { userId, finishedAt: { not: null } },
        orderBy: { solved: 'desc' },
        select: { solved: true },
      }),
    ]);

    return {
      rating: user.ratingPuzzle,
      totalSolved,
      totalAttempted,
      bestPuzzleRushScore: bestRush?.solved ?? null,
    };
  }

  /**
   * Get a specific puzzle by ID.
   */
  async getPuzzle(puzzleId: string) {
    const puzzle = await this.prisma.puzzle.findUnique({
      where: { id: puzzleId },
    });
    if (!puzzle) {
      throw new NotFoundException('Puzzle not found');
    }
    return this.formatPuzzle(puzzle);
  }

  private formatPuzzle(puzzle: {
    id: string;
    fen: string;
    moves: string;
    rating: number;
    themes: string[];
  }) {
    return {
      id: puzzle.id,
      fen: puzzle.fen,
      moves: puzzle.moves.split(' '),
      rating: puzzle.rating,
      themes: puzzle.themes,
    };
  }
}
