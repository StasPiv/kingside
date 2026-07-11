import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@kingside/db';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { StudyPlanGeneratorService } from './study-plan-generator.service';
import { StudyProfileService } from './study-profile.service';
import { nextSlotWithin } from './study-slot.util';

/**
 * KS-4881 / ADR-160 §4, cron-задание 1: генератор занятий.
 *
 * `EVERY_HOUR` + Redis-lock (`SET NX EX`, образец sm2.scheduler.ts —
 * blue/green api + api-green, работает ровно один инстанс). Для каждого
 * активного расписания: ближайший слот в пределах +25 ч; занятие на
 * слот ещё не создано → собрать профиль (§2.1), план (§2.2-2.3) и
 * записать StudySession + StudyTask одной транзакцией.
 *
 * Идемпотентность: UNIQUE (schedule_id, scheduled_at) — гонка или
 * повторный тик упираются в constraint (P2002) и пропускаются.
 * Генерация заранее (до +25 ч) отделяет тяжёлую сборку от отправки
 * (диспетчер — задача 3).
 */
@Injectable()
export class StudyGeneratorScheduler {
  private readonly logger = new Logger(StudyGeneratorScheduler.name);
  private static readonly LOCK_KEY = 'study:generator:hourly';
  /** TTL lock'а — 55 минут: короче периода, длиннее любого прогона. */
  private static readonly LOCK_TTL_SEC = 55 * 60;
  /** Горизонт генерации, часов (§4: «ближайший слот в пределах +25 ч»). */
  private static readonly HORIZON_HOURS = 25;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly generator: StudyPlanGeneratorService,
    private readonly profiles: StudyProfileService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async hourlyTick(): Promise<void> {
    try {
      const acquired = await this.redis
        .set(
          StudyGeneratorScheduler.LOCK_KEY,
          `${process.pid}:${Date.now()}`,
          'EX',
          StudyGeneratorScheduler.LOCK_TTL_SEC,
          'NX',
        )
        .catch(() => null);
      if (acquired !== 'OK') {
        this.logger.log('study generator: lock held by another instance, skipping');
        return;
      }
      const created = await this.generateDueSessions(new Date());
      if (created > 0) this.logger.log(`study generator: ${created} session(s) created`);
    } catch (e) {
      this.logger.error(`study generator tick failed: ${(e as Error).message}`);
    }
  }

  /**
   * Прогон генерации для всех активных расписаний. Вынесен из tick'а —
   * вызывается также вручную/из тестов с фиксированным `now`.
   * Возвращает число созданных занятий.
   */
  async generateDueSessions(now: Date): Promise<number> {
    const schedules = await this.prisma.studySchedule.findMany({
      where: { active: true },
    });
    let created = 0;
    for (const schedule of schedules) {
      try {
        if (await this.generateForSchedule(schedule, now)) created++;
      } catch (e) {
        this.logger.error(
          `study generator: schedule ${schedule.id} failed: ${(e as Error).message}`,
        );
      }
    }
    return created;
  }

  /**
   * Генерация занятия для ОДНОГО расписания (та же логика, что тик).
   * KS-4894: вызывается также из PUT /study/schedule — слот, попавший
   * между часовыми тиками, не проваливается. Идемпотентно: занятие на
   * слот уже есть (или параллельный тик успел первым, P2002) → false.
   */
  async generateForSchedule(
    schedule: { id: string; userId: string; sessionMinutes: number } & {
      daysOfWeek: number[];
      timeLocal: string;
      timezone: string;
    },
    now: Date,
  ): Promise<boolean> {
    const slot = nextSlotWithin(
      schedule,
      now,
      StudyGeneratorScheduler.HORIZON_HOURS,
    );
    if (!slot) return false;
    try {
      const exists = await this.prisma.studySession.findUnique({
        where: {
          scheduleId_scheduledAt: {
            scheduleId: schedule.id,
            scheduledAt: slot,
          },
        },
        select: { id: true },
      });
      if (exists) return false;
      return await this.createSession(schedule, slot);
    } catch (e) {
      // P2002 — параллельный тик успел первым: не ошибка.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return false;
      }
      throw e;
    }
  }

  private async createSession(
    schedule: { id: string; userId: string; sessionMinutes: number },
    slot: Date,
  ): Promise<boolean> {
    const profile = await this.profiles.collect(schedule.userId, schedule.id);
    const plan = this.generator.buildPlan(profile, schedule.sessionMinutes);
    if (plan.length === 0) {
      this.logger.warn(
        `study generator: empty plan for schedule ${schedule.id}, skipping slot`,
      );
      return false;
    }
    await this.prisma.studySession.create({
      data: {
        scheduleId: schedule.id,
        userId: schedule.userId,
        scheduledAt: slot,
        status: 'planned',
        profileSnapshot: profile as unknown as Prisma.InputJsonValue,
        tasks: {
          create: plan.map((task, i) => ({
            position: i,
            type: task.type,
            params: task.params as Prisma.InputJsonValue,
            targetCount: task.targetCount,
          })),
        },
      },
    });
    return true;
  }
}
