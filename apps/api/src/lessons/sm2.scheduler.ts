import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * Ежедневный планировщик SM-2 (ADR-025 §2.6, §2.7).
 *
 * Время: `@Cron('0 3 * * *')` — 03:00 UTC (06:00 MSK), минимум активности.
 *
 * Что делает:
 *   - считает агрегат «у сколько пользователей есть уроки с
 *     `due_at <= now()`» — пишется в лог и может использоваться для
 *     метрик / уведомлений (уведомления — отдельная задача).
 *   - НЕ пересчитывает `dueAt` в `LessonReview`: значение уже актуально
 *     (ставится при последнем повторе), выборка для UI идёт on-demand
 *     через индекс `(userId, dueAt)`.
 *
 * Distributed lock — Redis `SET NX EX` (TTL 1 час). В кластере из
 * нескольких API-инстансов сработает только один; остальные просто
 * залогируют и выйдут.
 */
@Injectable()
export class Sm2SchedulerService {
  private readonly logger = new Logger(Sm2SchedulerService.name);
  /** Ключ distributed-lock'а в Redis. */
  private static readonly LOCK_KEY = 'sm2:scheduler:daily';
  /** TTL lock'а — 1 час, с запасом на медленный tick. */
  private static readonly LOCK_TTL_SEC = 3600;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Запускается ежедневно в 03:00 UTC. Идемпотентен: если из кластера
   * успел сработать другой инстанс, мы просто выйдем.
   *
   * Ошибки БД / Redis не бросаются наружу (cron не любит uncaught),
   * логируются через `Logger.error`.
   */
  @Cron('0 3 * * *', { timeZone: 'UTC' })
  async dailyTick(): Promise<void> {
    try {
      const acquired = await this.redis
        .set(
          Sm2SchedulerService.LOCK_KEY,
          `${process.pid}:${Date.now()}`,
          'EX',
          Sm2SchedulerService.LOCK_TTL_SEC,
          'NX',
        )
        .catch(() => null);

      if (acquired !== 'OK') {
        this.logger.log('sm2 daily tick: lock held by another instance, skipping');
        return;
      }

      const now = new Date();
      const dueUsers = await this.prisma.lessonReview.groupBy({
        by: ['userId'],
        where: { dueAt: { lte: now } },
        _count: { _all: true },
      });

      const totalUsers = dueUsers.length;
      const totalLessons = dueUsers.reduce((acc, g) => acc + (g._count._all ?? 0), 0);

      this.logger.log(
        `sm2 daily tick: ${totalUsers} user(s) with due lessons, ${totalLessons} review(s) total`,
      );
    } catch (err) {
      this.logger.error(`sm2 daily tick failed: ${(err as Error).message}`);
    }
  }
}
