import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { PrismaService } from '../prisma/prisma.service';
import { PuzzleRatingService } from './puzzle-rating.service';

@Injectable()
export class PuzzleService {
  private readonly logger = new Logger(PuzzleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly i18n: I18nService,
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
      distinct: ['puzzleId'],
    });
    const excludeIds = attemptedIds.map((a) => a.puzzleId);

    const puzzles = await this.prisma.puzzle.findMany({
      where: {
        rating: { gte: minRating, lte: maxRating },
        id: { notIn: excludeIds.length > 0 ? excludeIds : undefined },
      },
      take: 10,
      orderBy: { popularity: 'desc' },
    });

    if (puzzles.length === 0) {
      const fallback = await this.prisma.puzzle.findFirst({
        where: {
          id: { notIn: excludeIds.length > 0 ? excludeIds : undefined },
        },
        orderBy: { rating: 'asc' },
      });
      if (!fallback) {
        throw new NotFoundException(this.i18n.t('messages.puzzle.noPuzzlesAvailable'));
      }
      return this.formatPuzzle(fallback);
    }

    const picked = puzzles[Math.floor(Math.random() * puzzles.length)];
    return this.formatPuzzle(picked);
  }

  /**
   * Search puzzles by theme and/or difficulty range.
   * Themes are stored as a space-separated string, so we use `contains` for filtering.
   */
  async findPuzzles(params: {
    themes?: string[];
    ratingMin?: number;
    ratingMax?: number;
    limit?: number;
  }) {
    const { themes, ratingMin, ratingMax, limit } = params;
    const take = limit ?? 10;

    const where: Record<string, any> = {};

    if (ratingMin !== undefined || ratingMax !== undefined) {
      where.rating = {};
      if (ratingMin !== undefined) where.rating.gte = ratingMin;
      if (ratingMax !== undefined) where.rating.lte = ratingMax;
    }

    if (themes && themes.length > 0) {
      where.AND = themes.map((theme) => ({
        themes: { contains: theme },
      }));
    }

    const puzzles = await this.prisma.puzzle.findMany({
      where,
      take,
      orderBy: { rating: 'asc' },
    });

    return puzzles.map((p) => this.formatPuzzle(p));
  }

  /**
   * Get next puzzle for user filtered by a specific theme.
   * Matches user rating ±200 and excludes already attempted puzzles.
   */
  async getNextPuzzleByTheme(userId: string, theme: string) {
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
      distinct: ['puzzleId'],
    });
    const excludeIds = attemptedIds.map((a) => a.puzzleId);

    const puzzles = await this.prisma.puzzle.findMany({
      where: {
        rating: { gte: minRating, lte: maxRating },
        themes: { contains: theme },
        id: { notIn: excludeIds.length > 0 ? excludeIds : undefined },
      },
      take: 10,
      orderBy: { rating: 'asc' },
    });

    if (puzzles.length === 0) {
      throw new NotFoundException(this.i18n.t('messages.puzzle.noPuzzlesAvailable'));
    }

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
  ) {
    const puzzle = await this.prisma.puzzle.findUnique({
      where: { id: puzzleId },
    });
    if (!puzzle) {
      throw new NotFoundException(this.i18n.t('messages.puzzle.notFound'));
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

    this.logger.log(
      `Puzzle ${puzzleId} ${solved ? 'solved' : 'failed'} by user ${userId}: rating ${ratingChange.userRatingBefore} -> ${ratingChange.userRatingAfter}`,
    );

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
  async getStats(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { ratingPuzzle: true },
    });

    const [totalAttempted, totalSolved, bestRush] = await Promise.all([
      this.prisma.puzzleAttempt.count({ where: { userId } }),
      this.prisma.puzzleAttempt.count({ where: { userId, solved: true } }),
      this.prisma.puzzleRushScore.findFirst({
        where: { userId },
        orderBy: { score: 'desc' },
        select: { score: true },
      }),
    ]);

    return {
      rating: user.ratingPuzzle,
      totalSolved,
      totalAttempted,
      bestPuzzleRushScore: bestRush?.score ?? null,
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
      throw new NotFoundException(this.i18n.t('messages.puzzle.notFound'));
    }
    return this.formatPuzzle(puzzle);
  }

  /**
   * Get user's recent puzzle attempts.
   */
  async getUserAttempts(userId: string, take = 20, skip = 0) {
    return this.prisma.puzzleAttempt.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: {
        puzzle: {
          select: { id: true, fen: true, rating: true, themes: true },
        },
      },
    });
  }

  private formatPuzzle(puzzle: {
    id: string;
    fen: string;
    moves: string;
    rating: number;
    themes: string;
  }) {
    return {
      id: puzzle.id,
      fen: puzzle.fen,
      moves: puzzle.moves.split(' '),
      rating: puzzle.rating,
      themes: puzzle.themes.split(' ').filter(Boolean),
    };
  }
}
