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
    private readonly puzzleRatingService: PuzzleRatingService,
  ) {}

  async getPuzzleById(id: string) {
    const puzzle = await this.prisma.puzzle.findUnique({
      where: { id },
    });

    if (!puzzle) {
      throw new NotFoundException(this.i18n.t('messages.puzzle.notFound'));
    }

    return puzzle;
  }

  async getRandomPuzzle(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { ratingPuzzle: true },
    });

    const ratingRange = 200;
    const minRating = user.ratingPuzzle - ratingRange;
    const maxRating = user.ratingPuzzle + ratingRange;

    const solvedIds = await this.prisma.puzzleAttempt.findMany({
      where: { userId },
      select: { puzzleId: true },
      distinct: ['puzzleId'],
    });

    const excludeIds = solvedIds.map((a) => a.puzzleId);

    const puzzles = await this.prisma.puzzle.findMany({
      where: {
        rating: { gte: minRating, lte: maxRating },
        id: { notIn: excludeIds.length > 0 ? excludeIds : undefined },
      },
      take: 10,
      orderBy: { popularity: 'desc' },
    });

    if (puzzles.length === 0) {
      throw new NotFoundException(this.i18n.t('messages.puzzle.noPuzzlesAvailable'));
    }

    const index = Math.floor(Math.random() * puzzles.length);
    return puzzles[index];
  }

  async submitAttempt(userId: string, puzzleId: string, solved: boolean) {
    const puzzle = await this.prisma.puzzle.findUnique({
      where: { id: puzzleId },
    });

    if (!puzzle) {
      throw new NotFoundException(this.i18n.t('messages.puzzle.notFound'));
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { ratingPuzzle: true },
    });

    const ratingBefore = user.ratingPuzzle;
    const ratingAfter = this.puzzleRatingService.calculateNewRating(
      ratingBefore,
      puzzle.rating,
      solved,
    );

    const attempt = await this.prisma.puzzleAttempt.create({
      data: {
        puzzleId,
        userId,
        solved,
        ratingBefore,
        ratingAfter,
      },
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { ratingPuzzle: ratingAfter },
    });

    this.logger.log(
      `Puzzle ${puzzleId} ${solved ? 'solved' : 'failed'} by user ${userId}: rating ${ratingBefore} -> ${ratingAfter}`,
    );

    return {
      attemptId: attempt.id,
      solved,
      ratingBefore,
      ratingAfter,
      ratingDelta: ratingAfter - ratingBefore,
    };
  }

  async getUserPuzzleStats(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ratingPuzzle: true },
    });

    if (!user) {
      throw new NotFoundException(this.i18n.t('messages.user.notFound'));
    }

    const [total, solved] = await Promise.all([
      this.prisma.puzzleAttempt.count({ where: { userId } }),
      this.prisma.puzzleAttempt.count({ where: { userId, solved: true } }),
    ]);

    return {
      rating: user.ratingPuzzle,
      totalAttempts: total,
      solved,
      failed: total - solved,
    };
  }

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
}
