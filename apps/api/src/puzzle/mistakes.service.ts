import { Injectable, Logger } from '@nestjs/common';
import type {
  PuzzleTheme,
  UserMistakeAggregate,
  UserMistakeAggregatesResponse,
  UserMistakeRecommendation,
  UserMistakeRecommendationsResponse,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Дневник ошибок (L-31, KS-1802).
 *
 * Источник истины по shape'у ответов — `packages/shared/src/types/lessons.ts`.
 * Источник данных — таблица `user_mistakes` (см. миграцию
 * `20260423203152_add_user_mistakes`).
 *
 * Идемпотентность:
 *  - `recordPuzzleMistake(userId, puzzleId)` — одна запись на пару
 *    `(userId, puzzleId)`, при повторной ошибке обновляется `occurredAt`.
 *    Индекс `user_mistakes_puzzle_unique (user_id, puzzle_id) WHERE source='puzzle'`
 *    (создан в SQL-миграции) страхует от гонок.
 *  - `recordGameMistake(userId, gameId, ply)` — одна запись на тройку
 *    `(userId, gameId, ply)`. Страховка — partial-уникальный индекс
 *    `user_mistakes_game_review_unique (user_id, game_id, ply) WHERE source='game_review'`.
 *
 * В обоих хуках мы сначала ищем запись и при её отсутствии создаём —
 * Prisma `upsert` тут не подходит, потому что `@@unique` в модели
 * отсутствует (partial unique не выражается на уровне схемы Prisma).
 * Попадание в гонку → дубликат пытается нарушить partial unique индекс →
 * мы ловим P2002 и молча игнорируем повтор.
 */
@Injectable()
export class MistakesService {
  private readonly logger = new Logger(MistakesService.name);

  /** Сколько дней смотреть в `getRecommendations`. */
  static readonly RECOMMENDATION_WINDOW_DAYS = 30;
  /** Ширина рейтингового диапазона рекомендаций (± от `ratingPuzzle`). */
  static readonly RECOMMENDATION_RATING_RANGE = 200;
  /** Сколько тем возвращать в `getRecommendations`. */
  static readonly RECOMMENDATION_TOP_N = 3;
  /** Default / max для `getAggregates.limit`. */
  static readonly AGGREGATE_DEFAULT_LIMIT = 20;
  static readonly AGGREGATE_MAX_LIMIT = 50;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Зафиксировать ошибку в задаче. Если запись уже есть — обновляем
   * `occurredAt` (это полезно для «свежести» рекомендаций).
   *
   * Темы берём из `Puzzle.themes` (строка, разделённая пробелами — формат
   * Lichess), чтобы агрегация по темам работала без join'ов в горячем пути.
   */
  async recordPuzzleMistake(userId: string, puzzleId: string): Promise<void> {
    const puzzle = await this.prisma.puzzle.findUnique({
      where: { id: puzzleId },
      select: { themes: true },
    });
    if (!puzzle) {
      this.logger.warn(`recordPuzzleMistake: puzzle ${puzzleId} not found`);
      return;
    }
    const themes = puzzle.themes.split(' ').filter(Boolean);

    const existing = await this.prisma.userMistake.findFirst({
      where: { userId, source: 'puzzle', puzzleId },
      select: { id: true },
    });

    try {
      if (existing) {
        await this.prisma.userMistake.update({
          where: { id: existing.id },
          data: { occurredAt: new Date(), themes },
        });
      } else {
        await this.prisma.userMistake.create({
          data: { userId, source: 'puzzle', puzzleId, themes },
        });
      }
    } catch (e) {
      // Partial-uniqueness гонок: игнорируем дубликат (P2002).
      if (isPrismaUniqueViolation(e)) {
        this.logger.debug(
          `recordPuzzleMistake race for user=${userId} puzzle=${puzzleId}, ignoring`,
        );
        return;
      }
      throw e;
    }
  }

  /**
   * Зафиксировать ошибку в партии (ход `ply` классифицирован как
   * `mistake`/`blunder`). `themes` передаёт вызывающий — обычно это
   * тематические теги, извлечённые из анализа (может быть пусто).
   */
  async recordGameMistake(
    userId: string,
    gameId: string,
    ply: number,
    themes: string[] = [],
  ): Promise<void> {
    const existing = await this.prisma.userMistake.findFirst({
      where: { userId, source: 'game_review', gameId, ply },
      select: { id: true },
    });

    try {
      if (existing) {
        await this.prisma.userMistake.update({
          where: { id: existing.id },
          data: { occurredAt: new Date(), themes },
        });
      } else {
        await this.prisma.userMistake.create({
          data: { userId, source: 'game_review', gameId, ply, themes },
        });
      }
    } catch (e) {
      if (isPrismaUniqueViolation(e)) {
        this.logger.debug(
          `recordGameMistake race for user=${userId} game=${gameId} ply=${ply}, ignoring`,
        );
        return;
      }
      throw e;
    }
  }

  /**
   * Агрегация ошибок пользователя по темам.
   *
   * Группируем через `UNNEST(themes)` — одна запись `user_mistakes`
   * вносит +1 в каждый свой тег. Сортировка: по убыванию `count`, при
   * равенстве — по свежести.
   */
  async getAggregates(
    userId: string,
    options: { since?: Date; limit?: number } = {},
  ): Promise<UserMistakeAggregatesResponse> {
    const limit = Math.min(
      Math.max(options.limit ?? MistakesService.AGGREGATE_DEFAULT_LIMIT, 1),
      MistakesService.AGGREGATE_MAX_LIMIT,
    );

    const sinceIso = options.since ? options.since.toISOString() : null;

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ theme: string; count: bigint; last_occurred_at: Date }>
    >(
      `
      SELECT theme,
             COUNT(*)::bigint         AS count,
             MAX(occurred_at)         AS last_occurred_at
      FROM user_mistakes,
           UNNEST(themes) AS theme
      WHERE user_id = $1::uuid
        ${sinceIso ? 'AND occurred_at >= $2::timestamp' : ''}
      GROUP BY theme
      ORDER BY count DESC, last_occurred_at DESC
      `,
      ...(sinceIso ? [userId, sinceIso] : [userId]),
    );

    const totalRows = await this.prisma.$queryRawUnsafe<
      Array<{ total: bigint }>
    >(
      `
      SELECT COUNT(DISTINCT theme)::bigint AS total
      FROM user_mistakes,
           UNNEST(themes) AS theme
      WHERE user_id = $1::uuid
        ${sinceIso ? 'AND occurred_at >= $2::timestamp' : ''}
      `,
      ...(sinceIso ? [userId, sinceIso] : [userId]),
    );
    const totalThemes = Number(totalRows[0]?.total ?? 0n);

    const aggregates: UserMistakeAggregate[] = rows
      .slice(0, limit)
      .map((r) => ({
        theme: r.theme as PuzzleTheme,
        count: Number(r.count),
        lastOccurredAt: r.last_occurred_at.toISOString(),
      }));

    return {
      aggregates,
      totalThemes,
      since: sinceIso,
      limit,
    };
  }

  /**
   * Топ-3 «проблемных» тем за последние `windowDays` дней → список
   * рекомендованных тренировочных сетов.
   *
   * Каждая рекомендация — готовый `PuzzleStep` с `selection.mode='filter'`
   * и `ratingMin/Max` вокруг `ratingPuzzle` игрока. Фронт может прокинуть
   * этот payload в эндпоинт L-06 (`PuzzleService.findPuzzles`) без
   * собственной логики.
   */
  async getRecommendations(
    userId: string,
  ): Promise<UserMistakeRecommendationsResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ratingPuzzle: true },
    });
    const ratingPuzzle = user?.ratingPuzzle ?? 1500;
    const windowDays = MistakesService.RECOMMENDATION_WINDOW_DAYS;
    const ratingRange = MistakesService.RECOMMENDATION_RATING_RANGE;

    const since = new Date();
    since.setDate(since.getDate() - windowDays);

    const aggregates = await this.getAggregates(userId, {
      since,
      limit: MistakesService.RECOMMENDATION_TOP_N,
    });

    const ratingMin = Math.max(0, ratingPuzzle - ratingRange);
    const ratingMax = ratingPuzzle + ratingRange;

    const recommendations: UserMistakeRecommendation[] = aggregates.aggregates.map(
      (a) => ({
        theme: a.theme,
        mistakeCount: a.count,
        lastOccurredAt: a.lastOccurredAt,
        puzzleStep: {
          type: 'puzzle',
          selection: {
            mode: 'filter',
            themes: [a.theme],
            ratingMin,
            ratingMax,
            limit: 10,
          },
          minSolved: 5,
        },
      }),
    );

    return {
      recommendations,
      ratingPuzzle,
      windowDays,
      ratingRange,
    };
  }
}

/**
 * Prisma выбрасывает `PrismaClientKnownRequestError` с `code = 'P2002'`
 * при нарушении уникального индекса. Проверяем code без импорта библиотеки
 * (чтобы не тянуть runtime-зависимость от `@prisma/client` в сервис).
 */
function isPrismaUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: unknown }).code === 'P2002'
  );
}
