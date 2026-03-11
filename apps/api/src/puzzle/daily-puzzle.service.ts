import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DailyPuzzleService {
  constructor(private readonly prisma: PrismaService) {}

  async getDailyPuzzle(date?: Date) {
    const targetDate = date ?? new Date();
    const dateOnly = this.toDateOnly(targetDate);

    const daily = await this.prisma.dailyPuzzle.findUnique({
      where: { date: dateOnly },
      include: {
        puzzle: true,
      },
    });

    if (daily) {
      return this.formatResponse(daily);
    }

    const puzzle = await this.selectPuzzleForDate(dateOnly);
    if (!puzzle) {
      throw new NotFoundException('No puzzles available');
    }

    const created = await this.prisma.dailyPuzzle.create({
      data: {
        puzzleId: puzzle.id,
        date: dateOnly,
      },
      include: {
        puzzle: true,
      },
    });

    return this.formatResponse(created);
  }

  private async selectPuzzleForDate(date: Date) {
    const usedPuzzleIds = await this.prisma.dailyPuzzle.findMany({
      select: { puzzleId: true },
    });

    const excludeIds = usedPuzzleIds.map((d) => d.puzzleId);

    const seed = this.dateSeed(date);

    // Daily puzzle uses high-difficulty puzzles (Lichess DB, CC0 license).
    // Rating >= 2000 ensures complex positions: deep mates, endgame studies,
    // long tactical sequences — not puzzle-rush level.
    const DAILY_MIN_RATING = 2000;

    const totalAvailable = await this.prisma.puzzle.count({
      where: {
        id: { notIn: excludeIds },
        rating: { gte: DAILY_MIN_RATING },
      },
    });

    if (totalAvailable === 0) {
      return this.prisma.puzzle.findFirst({
        where: { rating: { gte: DAILY_MIN_RATING } },
        orderBy: { rating: 'asc' },
      });
    }

    const skip = seed % totalAvailable;

    return this.prisma.puzzle.findFirst({
      where: {
        id: { notIn: excludeIds },
        rating: { gte: DAILY_MIN_RATING },
      },
      orderBy: { rating: 'asc' },
      skip,
    });
  }

  private toDateOnly(date: Date): Date {
    return new Date(
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
    );
  }

  private dateSeed(date: Date): number {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    return ((y * 10000 + m * 100 + d) * 2654435761) >>> 0;
  }

  private formatResponse(daily: {
    id: string;
    date: Date;
    puzzle: {
      id: string;
      fen: string;
      moves: string;
      rating: number;
      ratingDev: number;
      themes: string;
    };
  }) {
    return {
      id: daily.id,
      date: daily.date,
      puzzle: {
        id: daily.puzzle.id,
        fen: daily.puzzle.fen,
        moves: daily.puzzle.moves,
        rating: daily.puzzle.rating,
        ratingDeviation: daily.puzzle.ratingDev,
        themes: daily.puzzle.themes.split(' ').filter(Boolean),
      },
    };
  }
}
