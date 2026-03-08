import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma';

const DEFAULT_LIMIT = 10;
const DEFAULT_RATING_RANGE = 200;

@Injectable()
export class PuzzleService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Подбор задач по теме и уровню сложности (рейтингу).
   *
   * - themes: фильтрация по темам (puzzle должен содержать ВСЕ указанные темы)
   * - ratingMin / ratingMax: диапазон сложности
   * - limit: максимальное количество результатов
   */
  async findPuzzles(params: {
    themes?: string[];
    ratingMin?: number;
    ratingMax?: number;
    limit?: number;
  }) {
    const { themes, ratingMin, ratingMax, limit } = params;
    const take = limit ?? DEFAULT_LIMIT;

    const where: Prisma.PuzzleWhereInput = {};

    if (ratingMin !== undefined || ratingMax !== undefined) {
      where.rating = {};
      if (ratingMin !== undefined) where.rating.gte = ratingMin;
      if (ratingMax !== undefined) where.rating.lte = ratingMax;
    }

    if (themes && themes.length > 0) {
      where.themes = { hasEvery: themes };
    }

    return this.prisma.puzzle.findMany({
      where,
      take,
      orderBy: { rating: 'asc' },
      select: {
        id: true,
        fen: true,
        moves: true,
        rating: true,
        ratingDeviation: true,
        themes: true,
      },
    });
  }

  /**
   * Подбор задачи для пользователя на основе его рейтинга.
   * Выбирает случайную задачу в диапазоне ±DEFAULT_RATING_RANGE от рейтинга пользователя.
   * Исключает уже решённые задачи.
   */
  async findPuzzleForUser(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { ratingPuzzle: true },
    });

    const solvedIds = await this.prisma.puzzleAttempt.findMany({
      where: { userId },
      select: { puzzleId: true },
      distinct: ['puzzleId'],
    });

    const excludeIds = solvedIds.map((a) => a.puzzleId);

    const where: Prisma.PuzzleWhereInput = {
      rating: {
        gte: user.ratingPuzzle - DEFAULT_RATING_RANGE,
        lte: user.ratingPuzzle + DEFAULT_RATING_RANGE,
      },
    };

    if (excludeIds.length > 0) {
      where.id = { notIn: excludeIds };
    }

    const count = await this.prisma.puzzle.count({ where });
    if (count === 0) return null;

    const skip = Math.floor(Math.random() * count);

    const puzzles = await this.prisma.puzzle.findMany({
      where,
      take: 1,
      skip,
      select: {
        id: true,
        fen: true,
        moves: true,
        rating: true,
        ratingDeviation: true,
        themes: true,
      },
    });

    return puzzles[0] ?? null;
  }

  /**
   * Подбор задачи по конкретной теме для пользователя.
   * Учитывает рейтинг пользователя и исключает решённые.
   */
  async findPuzzleByThemeForUser(userId: string, theme: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { ratingPuzzle: true },
    });

    const solvedIds = await this.prisma.puzzleAttempt.findMany({
      where: { userId },
      select: { puzzleId: true },
      distinct: ['puzzleId'],
    });

    const excludeIds = solvedIds.map((a) => a.puzzleId);

    const where: Prisma.PuzzleWhereInput = {
      rating: {
        gte: user.ratingPuzzle - DEFAULT_RATING_RANGE,
        lte: user.ratingPuzzle + DEFAULT_RATING_RANGE,
      },
      themes: { has: theme },
    };

    if (excludeIds.length > 0) {
      where.id = { notIn: excludeIds };
    }

    const count = await this.prisma.puzzle.count({ where });
    if (count === 0) return null;

    const skip = Math.floor(Math.random() * count);

    const puzzles = await this.prisma.puzzle.findMany({
      where,
      take: 1,
      skip,
      select: {
        id: true,
        fen: true,
        moves: true,
        rating: true,
        ratingDeviation: true,
        themes: true,
      },
    });

    return puzzles[0] ?? null;
  }

  async getPuzzleById(id: string) {
    return this.prisma.puzzle.findUnique({
      where: { id },
      select: {
        id: true,
        fen: true,
        moves: true,
        rating: true,
        ratingDeviation: true,
        themes: true,
      },
    });
  }
}
