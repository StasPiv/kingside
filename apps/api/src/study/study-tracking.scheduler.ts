import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@kingside/db';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ExternalChessService } from '../workshop/external-chess.service';
import { StudyTrackingService } from './study-tracking.service';

/**
 * KS-4884 / ADR-160 §5. Два cron-задания трекинга:
 *
 * 1. Reconciliation (`EVERY_15_MINUTES`, Redis-lock): пересчёт
 *    done_count задач по фактам для сессий notified|in_progress за
 *    последние 48 ч + перевод просроченных в expired (конец локального
 *    дня расписания).
 *
 * 2. Внешние снапшоты (ежедневно 02:40 UTC, Redis-lock): для
 *    пользователей с активным расписанием и заполненным
 *    lichess/chess.com username — партии и рейтинги за ВЧЕРАШНИЕ сутки
 *    UTC → upsert ExternalActivitySnapshot. Щадящий режим (§5.2):
 *    только активные расписания, последовательные вызовы с паузой.
 */
@Injectable()
export class StudyTrackingScheduler {
  private readonly logger = new Logger(StudyTrackingScheduler.name);
  private static readonly RECONCILE_LOCK = 'study:reconcile:15min';
  private static readonly RECONCILE_LOCK_TTL_SEC = 14 * 60;
  private static readonly SNAPSHOT_LOCK = 'study:external-snapshot:daily';
  private static readonly SNAPSHOT_LOCK_TTL_SEC = 3600;
  /** Пауза между пользователями при обходе внешних API, мс. */
  private static readonly THROTTLE_MS = 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly tracking: StudyTrackingService,
    private readonly externalChess: ExternalChessService,
  ) {}

  @Cron('0 */15 * * * *') // каждые 15 минут (в enum @nestjs/schedule нет EVERY_15_MINUTES)
  async reconcileTick(): Promise<void> {
    try {
      if (!(await this.acquire(
        StudyTrackingScheduler.RECONCILE_LOCK,
        StudyTrackingScheduler.RECONCILE_LOCK_TTL_SEC,
      ))) {
        return;
      }
      const now = new Date();
      const reconciled = await this.tracking.reconcileRecent(now);
      const expired = await this.tracking.expireOverdue(now);
      if (reconciled > 0 || expired > 0) {
        this.logger.log(
          `study reconcile: ${reconciled} session(s) checked, ${expired} expired`,
        );
      }
    } catch (e) {
      this.logger.error(`study reconcile tick failed: ${(e as Error).message}`);
    }
  }

  /** 02:40 UTC — после суточного затишья, до утренних слотов Европы. */
  @Cron('40 2 * * *', { timeZone: 'UTC' })
  async snapshotTick(): Promise<void> {
    try {
      if (!(await this.acquire(
        StudyTrackingScheduler.SNAPSHOT_LOCK,
        StudyTrackingScheduler.SNAPSHOT_LOCK_TTL_SEC,
      ))) {
        return;
      }
      const count = await this.snapshotYesterday(new Date());
      this.logger.log(`study external snapshots: ${count} written`);
    } catch (e) {
      this.logger.error(`study snapshot tick failed: ${(e as Error).message}`);
    }
  }

  /**
   * Снапшоты за вчерашние сутки UTC. Возвращает число записанных строк.
   * Вынесен из tick'а — вызывается из тестов с фиксированным `now`.
   */
  async snapshotYesterday(now: Date): Promise<number> {
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
    );
    const users = await this.prisma.user.findMany({
      where: {
        studySchedule: { active: true },
        OR: [
          { lichessUsername: { not: null } },
          { chesscomUsername: { not: null } },
        ],
      },
      select: { id: true, lichessUsername: true, chesscomUsername: true },
    });

    let written = 0;
    for (const user of users) {
      const jobs: Array<{ provider: string; username: string }> = [];
      if (user.lichessUsername) {
        jobs.push({ provider: 'lichess', username: user.lichessUsername });
      }
      if (user.chesscomUsername) {
        jobs.push({ provider: 'chesscom', username: user.chesscomUsername });
      }
      for (const job of jobs) {
        try {
          const activity =
            job.provider === 'lichess'
              ? await this.externalChess.fetchLichessDailyActivity(job.username, dayStart)
              : await this.externalChess.fetchChesscomDailyActivity(job.username, dayStart);
          await this.prisma.externalActivitySnapshot.upsert({
            where: {
              userId_provider_date: {
                userId: user.id,
                provider: job.provider,
                date: dayStart,
              },
            },
            create: {
              userId: user.id,
              provider: job.provider,
              date: dayStart,
              gamesPlayed: activity.gamesPlayed,
              ratings: activity.ratings as Prisma.InputJsonValue,
            },
            update: {
              gamesPlayed: activity.gamesPlayed,
              ratings: activity.ratings as Prisma.InputJsonValue,
            },
          });
          written++;
        } catch (e) {
          this.logger.warn(
            `snapshot ${job.provider}/${job.username} failed: ${(e as Error).message}`,
          );
        }
        // Щадящий режим по rate-limit внешних API (§5.2).
        await new Promise((r) => setTimeout(r, StudyTrackingScheduler.THROTTLE_MS));
      }
    }
    return written;
  }

  private async acquire(key: string, ttlSec: number): Promise<boolean> {
    const acquired = await this.redis
      .set(key, `${process.pid}:${Date.now()}`, 'EX', ttlSec, 'NX')
      .catch(() => null);
    return acquired === 'OK';
  }
}
