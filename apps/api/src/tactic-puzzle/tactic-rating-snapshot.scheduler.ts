/**
 * KS-4357 / ADR-136 §3.6. Ежедневный планировщик снимка рейтинга
 * пользователей в `tactic_rating_snapshots`. Точки графика истории
 * рейтинга `GET /tactic-puzzles/stats/rating-history`.
 *
 * По образцу `Sm2SchedulerService`:
 *   * `@Cron('10 3 * * *', { timeZone: 'UTC' })` — 03:10 UTC, со
 *     сдвигом от sm2 (03:00), чтобы оба не дёргали БД одновременно;
 *   * distributed lock через Redis `SET NX EX` — в кластере из
 *     нескольких API-инстансов сработает только один;
 *   * ошибки ловятся в `try/catch` и логируются — Nest cron не любит
 *     uncaught rejections.
 *
 * Стратегия выбора пользователей:
 *   * пишем снимок только тем, кто играл за предыдущие сутки UTC
 *     (`createdAt ∈ [yesterday, today)`). Пользователи без активности
 *     не порождают пустые точки графика — фронт линейно соединит
 *     соседние точки.
 *   * `rating` берём из `user_tactic_ratings` (актуальное значение
 *     после последней попытки этого пользователя — то, что нужно
 *     показать на графике).
 *   * `attempts` / `solved` — счётчики за прошедшие сутки, не
 *     накопительно. Аналогично `puzzle_rating_snapshots` (см.
 *     `puzzle-rating.service.ts`).
 *
 * Идемпотентность: UNIQUE(`user_id`, `date`) в `tactic_rating_snapshots`
 * (см. миграцию KS-4354). Upsert повторного запуска за тот же день
 * пересчитает значения без дубликата.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const DEFAULT_USER_RATING = 1500;

interface DayWindow {
  /** Старт прошедших суток UTC (включительно). */
  from: Date;
  /** Конец прошедших суток UTC (исключительно) = сегодня 00:00 UTC. */
  to: Date;
  /** Дата снимка в `tactic_rating_snapshots.date` — `from` (UTC-день). */
  snapshotDate: Date;
}

@Injectable()
export class TacticRatingSnapshotScheduler {
  private readonly logger = new Logger(TacticRatingSnapshotScheduler.name);
  private static readonly LOCK_KEY = 'tactic-rating-snapshot:scheduler:daily';
  /** TTL — 1 час с запасом на медленный tick (тысячи пользователей). */
  private static readonly LOCK_TTL_SEC = 3600;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Запускается ежедневно 03:10 UTC. Идемпотентно через UNIQUE-индекс
   * `tactic_rating_snapshots_user_id_date_key`.
   */
  @Cron('10 3 * * *', { timeZone: 'UTC' })
  async dailyTick(): Promise<void> {
    try {
      const acquired = await this.redis
        .set(
          TacticRatingSnapshotScheduler.LOCK_KEY,
          `${process.pid}:${Date.now()}`,
          'EX',
          TacticRatingSnapshotScheduler.LOCK_TTL_SEC,
          'NX',
        )
        .catch(() => null);

      if (acquired !== 'OK') {
        this.logger.log(
          'tactic-rating-snapshot daily tick: lock held by another instance, skipping',
        );
        return;
      }

      await this.runOnce(new Date());
    } catch (err) {
      this.logger.error(
        `tactic-rating-snapshot daily tick failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Один прогон — выделен в публичный метод для юнит-теста: тест
   * подаёт фиксированное «сейчас» и проверяет, что upsert вызывается
   * с правильным `(userId, date)` и счётчиками.
   *
   * Возвращает количество записанных снимков (для логов / метрик).
   */
  async runOnce(now: Date): Promise<{ users: number; snapshots: number }> {
    const window = previousUtcDayWindow(now);

    // Агрегаты попыток за прошедшие сутки. Используем groupBy, чтобы
    // получить только активных пользователей одним запросом.
    const groups = await this.prisma.tacticPuzzleAttempt.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: window.from, lt: window.to } },
      _count: { _all: true },
    });
    if (groups.length === 0) {
      this.logger.log(
        `tactic-rating-snapshot: no activity in ${window.snapshotDate.toISOString().slice(0, 10)}, 0 snapshots`,
      );
      return { users: 0, snapshots: 0 };
    }

    const userIds = groups.map((g) => g.userId);
    // Solved-каунты отдельным groupBy: Prisma не умеет COUNT FILTER
    // в одном groupBy. Это всё ещё один SELECT, индексированный по
    // (user_id, created_at).
    const solvedGroups = await this.prisma.tacticPuzzleAttempt.groupBy({
      by: ['userId'],
      where: {
        createdAt: { gte: window.from, lt: window.to },
        solved: true,
        userId: { in: userIds },
      },
      _count: { _all: true },
    });
    const solvedByUser = new Map<string, number>();
    for (const g of solvedGroups) {
      solvedByUser.set(g.userId, g._count._all ?? 0);
    }

    const ratings = await this.prisma.userTacticRating.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, rating: true },
    });
    const ratingByUser = new Map<string, number>();
    for (const r of ratings) ratingByUser.set(r.userId, r.rating);

    let written = 0;
    for (const g of groups) {
      const attempts = g._count._all ?? 0;
      const solved = solvedByUser.get(g.userId) ?? 0;
      const rating = ratingByUser.get(g.userId) ?? DEFAULT_USER_RATING;
      try {
        await this.prisma.tacticRatingSnapshot.upsert({
          where: {
            userId_date: { userId: g.userId, date: window.snapshotDate },
          },
          update: { rating, attempts, solved },
          create: {
            userId: g.userId,
            date: window.snapshotDate,
            rating,
            attempts,
            solved,
          },
        });
        written++;
      } catch (err) {
        // Один проблемный пользователь не валит весь tick.
        this.logger.warn(
          `tactic-rating-snapshot upsert failed user=${g.userId}: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `tactic-rating-snapshot: ${written}/${groups.length} snapshot(s) for ${window.snapshotDate.toISOString().slice(0, 10)}`,
    );
    return { users: groups.length, snapshots: written };
  }
}

/**
 * Прошедшие сутки UTC относительно `now`. Например, `now = 03:10 UTC
 * 2026-06-20` → from = 00:00 UTC 2026-06-19, to = 00:00 UTC 2026-06-20,
 * snapshotDate = 2026-06-19 (UTC день).
 */
export function previousUtcDayWindow(now: Date): DayWindow {
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  return {
    from: yesterday,
    to: today,
    snapshotDate: yesterday,
  };
}
