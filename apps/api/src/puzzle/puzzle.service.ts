import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { PuzzleRatingService } from './puzzle-rating.service';

@Injectable()
export class PuzzleService {
  private readonly logger = new Logger(PuzzleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly i18n: I18nService,
    private readonly puzzleRating: PuzzleRatingService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Get a puzzle matching the user's current rating (±200 range).
   * Excludes puzzles the user has already solved.
   */
  async getNextPuzzle(
    userId: string | null,
    excludeId?: string,
    filters?: { themes?: string[]; ratingMin?: number; ratingMax?: number },
  ) {
    const DEFAULT_RATING = 1500;
    const range = 200;
    let userRating = DEFAULT_RATING;
    const excludeIds: string[] = [];

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { ratingPuzzle: true },
      });
      if (user) userRating = user.ratingPuzzle;

      const attemptedIds = await this.prisma.puzzleAttempt.findMany({
        where: { userId },
        select: { puzzleId: true },
        distinct: ['puzzleId'],
      });
      excludeIds.push(...attemptedIds.map((a) => a.puzzleId));
    }

    const minRating = filters?.ratingMin ?? userRating - range;
    const maxRating = filters?.ratingMax ?? userRating + range;
    if (excludeId && !excludeIds.includes(excludeId)) {
      excludeIds.push(excludeId);
    }

    const where: Record<string, unknown> = {
      rating: { gte: minRating, lte: maxRating },
      id: { notIn: excludeIds.length > 0 ? excludeIds : undefined },
    };

    if (filters?.themes && filters.themes.length > 0) {
      where.AND = filters.themes.map((t) => ({ themes: { contains: t } }));
    }

    const puzzles = await this.prisma.puzzle.findMany({
      where,
      take: 10,
      orderBy: { popularity: 'desc' },
    });

    if (puzzles.length === 0) {
      const fallbackWhere: Record<string, unknown> = {
        id: { notIn: excludeIds.length > 0 ? excludeIds : undefined },
      };
      if (filters?.themes && filters.themes.length > 0) {
        fallbackWhere.AND = filters.themes.map((t) => ({ themes: { contains: t } }));
      }
      const fallback = await this.prisma.puzzle.findFirst({
        where: fallbackWhere,
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
   * Get all available puzzle themes with counts.
   */
  async getThemes(): Promise<{ theme: string; count: number }[]> {
    const puzzles = await this.prisma.puzzle.findMany({
      select: { themes: true },
    });

    const counts = new Map<string, number>();
    for (const p of puzzles) {
      for (const t of p.themes.split(' ').filter(Boolean)) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }

    return Array.from(counts.entries())
      .map(([theme, count]) => ({ theme, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Get next puzzle for user filtered by a specific theme.
   * Matches user rating ±200 and excludes already attempted puzzles.
   */
  async getNextPuzzleByTheme(userId: string | null, theme: string, excludeId?: string) {
    const DEFAULT_RATING = 1500;
    const range = 200;
    let userRating = DEFAULT_RATING;
    const excludeIds: string[] = [];

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { ratingPuzzle: true },
      });
      if (user) userRating = user.ratingPuzzle;

      const attemptedIds = await this.prisma.puzzleAttempt.findMany({
        where: { userId },
        select: { puzzleId: true },
        distinct: ['puzzleId'],
      });
      excludeIds.push(...attemptedIds.map((a) => a.puzzleId));
    }

    const minRating = userRating - range;
    const maxRating = userRating + range;
    if (excludeId && !excludeIds.includes(excludeId)) {
      excludeIds.push(excludeId);
    }

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
    userMoves?: string,
    hintsUsed?: number,
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
        userMoves: userMoves ?? null,
        hintsUsed: hintsUsed ?? 0,
      },
    });

    this.logger.log(
      `Puzzle ${puzzleId} ${solved ? 'solved' : 'failed'} by user ${userId}: rating ${ratingChange.userRatingBefore} -> ${ratingChange.userRatingAfter}`,
    );

    // Fetch next puzzle atomically to avoid race condition (KS-177):
    // the attempt is already persisted, so getNextPuzzle will correctly
    // exclude this puzzle if it was solved.
    let nextPuzzle = null;
    try {
      nextPuzzle = await this.getNextPuzzle(userId, puzzleId);
    } catch (e: unknown) { this.logger.warn(`Daily puzzle error: ${(e as Error).message ?? e}`);
      // no puzzles available — not critical
    }

    return {
      solved,
      puzzleRating: ratingChange.puzzleRatingAfter,
      userRatingBefore: ratingChange.userRatingBefore,
      userRatingAfter: ratingChange.userRatingAfter,
      correctMoves: puzzle.moves.split(' '),
      nextPuzzle,
    };
  }

  /**
   * Get puzzle statistics for a user.
   */
  async getStats(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { ratingPuzzle: true, ratingPuzzleDev: true, puzzleStreak: true },
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalAttempted, totalSolved, genAttempted, genSolved, bestRush, avgTime, todaySnapshot] = await Promise.all([
      this.prisma.puzzleAttempt.count({ where: { userId } }),
      this.prisma.puzzleAttempt.count({ where: { userId, solved: true } }),
      this.prisma.generatedPuzzleAttempt.count({ where: { userId } }),
      this.prisma.generatedPuzzleAttempt.count({ where: { userId, solved: true } }),
      this.prisma.puzzleRushScore.findFirst({
        where: { userId },
        orderBy: { score: 'desc' },
        select: { score: true },
      }),
      this.prisma.puzzleAttempt.aggregate({
        where: { userId },
        _avg: { timeMs: true },
      }),
      this.prisma.puzzleRatingSnapshot.findUnique({
        where: { userId_date: { userId, date: today } },
      }),
    ]);

    const allAttempted = totalAttempted + genAttempted;
    const allSolved = totalSolved + genSolved;

    return {
      rating: user.ratingPuzzle,
      ratingDev: user.ratingPuzzleDev,
      totalSolved: allSolved,
      totalAttempted: allAttempted,
      solveRate: allAttempted > 0 ? Math.round((allSolved / allAttempted) * 100) : 0,
      avgTimeMs: Math.round(avgTime._avg.timeMs ?? 0),
      currentStreak: user.puzzleStreak,
      todaySolved: todaySnapshot?.solved ?? 0,
      todayAttempted: todaySnapshot?.attempts ?? 0,
      bestPuzzleRushScore: bestRush?.score ?? null,
    };
  }

  async getRatingHistory(userId: string, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const snapshots = await this.prisma.puzzleRatingSnapshot.findMany({
      where: { userId, date: { gte: since } },
      orderBy: { date: 'asc' },
      select: { date: true, rating: true, attempts: true, solved: true },
    });

    return snapshots.map((s: { date: Date; rating: number; attempts: number; solved: number }) => ({
      date: s.date.toISOString().slice(0, 10),
      rating: s.rating,
      attempts: s.attempts,
      solved: s.solved,
    }));
  }

  async getThemeStats(userId: string) {
    const cacheKey = `puzzle:theme-stats:${userId}`;
    const cached = await this.redis.get(cacheKey).catch(() => null);
    if (cached) return JSON.parse(cached);

    // Aggregate from puzzle_attempts joined with puzzles (lichess)
    const raw = await this.prisma.$queryRaw<Array<{ themes: string; total: bigint; solved: bigint }>>`
      SELECT p.themes, COUNT(*)::bigint as total, SUM(CASE WHEN pa.solved THEN 1 ELSE 0 END)::bigint as solved
      FROM puzzle_attempts pa
      JOIN puzzles p ON pa.puzzle_id = p.id
      WHERE pa.user_id = ${userId}::uuid AND p.themes != ''
      GROUP BY p.themes
    `;

    const themeMap = new Map<string, { attempted: number; solved: number }>();
    for (const row of raw) {
      for (const theme of row.themes.split(' ').filter(Boolean)) {
        const existing = themeMap.get(theme) ?? { attempted: 0, solved: 0 };
        existing.attempted += Number(row.total);
        existing.solved += Number(row.solved);
        themeMap.set(theme, existing);
      }
    }

    const result = Array.from(themeMap.entries())
      .map(([theme, stats]) => ({
        theme,
        attempted: stats.attempted,
        solved: stats.solved,
        rate: stats.attempted > 0 ? Math.round((stats.solved / stats.attempted) * 100) : 0,
      }))
      .sort((a, b) => b.attempted - a.attempted);

    await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 300).catch(() => {});
    return result;
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
    // Fetch from both tables, merge, sort by date
    const [lichess, generated] = await Promise.all([
      this.prisma.puzzleAttempt.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: take + skip, // overfetch for merge
        include: {
          puzzle: { select: { id: true, fen: true, rating: true, themes: true } },
        },
      }),
      this.prisma.generatedPuzzleAttempt.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: take + skip,
        include: {
          puzzle: { select: { id: true, fen: true, rating: true, themes: true } },
        },
      }),
    ]);

    const merged = [
      ...lichess.map((a: any) => ({
        id: a.id,
        puzzleId: a.puzzleId,
        solved: a.solved,
        timeMs: a.timeMs,
        ratingBefore: a.ratingBefore,
        ratingAfter: a.ratingAfter,
        userMoves: a.userMoves ?? null,
        hintsUsed: a.hintsUsed ?? 0,
        createdAt: a.createdAt,
        puzzleType: 'lichess' as const,
        puzzle: a.puzzle,
      })),
      ...generated.map((a: any) => ({
        id: a.id,
        puzzleId: a.puzzleId,
        solved: a.solved,
        timeMs: a.timeMs,
        ratingBefore: a.userRatingBefore,
        ratingAfter: a.userRatingAfter,
        userMoves: a.userMoves ?? null,
        hintsUsed: a.hintsUsed ?? 0,
        createdAt: a.createdAt,
        puzzleType: 'generated' as const,
        puzzle: a.puzzle,
      })),
    ];

    merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return merged.slice(skip, skip + take);
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
