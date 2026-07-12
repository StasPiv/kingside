import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@kingside/db';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  PlannedTask,
  StudyPlanGeneratorService,
  StudyProfile,
  StudyTaskType,
} from './study-plan-generator.service';
import { StudyProfileService } from './study-profile.service';
import { StudyLessonBuilderService } from './study-lesson-builder.service';
import { shelfWithFocus } from './study-shelves';
import { BaselineMaterialSource } from './material/baseline-material.source';
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
    private readonly lessonBuilder: StudyLessonBuilderService,
    private readonly material: BaselineMaterialSource,
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
        const r = await this.generateForSchedule(schedule, now);
        if (r.outcome === 'created') created++;
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
   * между часовыми тиками, не проваливается. Идемпотентно.
   *
   * KS-4896: возвращает исход (не boolean) — вызывающий логирует
   * решение генератора, иначе «сессии нет» не диагностируется по логам.
   */
  async generateForSchedule(
    schedule: { id: string; userId: string; sessionMinutes: number } & {
      daysOfWeek: number[];
      timeLocal: string;
      timezone: string;
      focus?: string | null;
    },
    now: Date,
  ): Promise<{ outcome: 'created' | 'exists' | 'no_slot' | 'empty_plan'; slot: Date | null }> {
    const slot = nextSlotWithin(
      schedule,
      now,
      StudyGeneratorScheduler.HORIZON_HOURS,
    );
    if (!slot) return { outcome: 'no_slot', slot: null };
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
      if (exists) return { outcome: 'exists', slot };
      const created = await this.createSession(schedule, slot);
      return { outcome: created ? 'created' : 'empty_plan', slot };
    } catch (e) {
      // P2002 — параллельный тик успел первым: не ошибка.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return { outcome: 'exists', slot };
      }
      throw e;
    }
  }

  /**
   * KS-4910/KS-4911 / ADR-162: занятие v2 = персональный урок (main) +
   * 1–2 homework-задачи. Полка — константы study-shelves.ts
   * (focus-оверрайд расписания учитывается), материал — через
   * LessonMaterialSource (baseline), урок — клонирование шаблонного
   * курса study-template-<shelf> в скрытый персональный курс.
   */
  private async createSession(
    schedule: {
      id: string;
      userId: string;
      sessionMinutes: number;
      focus?: string | null;
    },
    slot: Date,
  ): Promise<boolean> {
    const profile = await this.profiles.collect(schedule.userId, schedule.id);
    const shelf = shelfWithFocus(
      profile.ratingPuzzle,
      profile.ratingPuzzleDev,
      schedule.focus ?? null,
    );
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: schedule.userId },
      select: { locale: true },
    });
    const lang = user.locale === 'ru' ? 'ru' : 'en';

    // Слабые темы профиля пусты → приоритетные темы полки (§3.2).
    if (profile.weakThemes.length === 0) {
      profile.weakThemes = shelf.priorityThemes.map((theme) => ({
        theme,
        attempted: 0,
        rate: 0,
      }));
    }

    const window = this.generator.ratingWindow(profile);
    const materialData = await this.material.extract(schedule.userId, profile);
    const lesson = await this.lessonBuilder.buildLesson(
      schedule.userId,
      lang,
      shelf,
      {
        min: profile.ratingPuzzle + window.min,
        max: profile.ratingPuzzle + window.max,
      },
      materialData,
    );

    const tasks: Array<PlannedTask & { role: string }> = [
      {
        role: 'main',
        type: 'lesson',
        params: {
          lessonId: lesson.lessonId,
          courseId: lesson.courseId,
          courseSlug: lesson.courseSlug,
          themeLabel: lesson.themeLabel,
        },
        targetCount: 1,
      },
      ...this.homework(profile, shelf, window).map((t) => ({
        ...t,
        role: 'homework',
      })),
    ];

    await this.prisma.studySession.create({
      data: {
        scheduleId: schedule.id,
        userId: schedule.userId,
        scheduledAt: slot,
        status: 'planned',
        lessonId: lesson.lessonId,
        profileSnapshot: {
          ...profile,
          shelf: shelf.key,
          themeLabel: lesson.themeLabel,
        } as unknown as Prisma.InputJsonValue,
        tasks: {
          create: tasks.map((task, i) => ({
            position: i,
            role: task.role,
            type: task.type,
            params: task.params as Prisma.InputJsonValue,
            targetCount: task.targetCount,
          })),
        },
      },
    });
    return true;
  }

  /**
   * Домашнее задание (ADR-162 §5): 1–2 задачи существующих типов —
   * тактика по теме занятия + практика из ротации полки (тип, не
   * использованный дольше всех; reconciliation v1 проверяет как раньше).
   */
  private homework(
    profile: StudyProfile,
    shelf: { practiceRotation: string[] },
    window: { min: number; max: number },
  ): PlannedTask[] {
    const theme = profile.carryOver.theme ?? profile.weakThemes[0]?.theme ?? null;
    const tasks: PlannedTask[] = [
      {
        type: 'puzzle_theme',
        params: {
          theme,
          ratingMin: profile.ratingPuzzle + window.min,
          ratingMax: profile.ratingPuzzle + window.max,
        },
        targetCount: 8,
      },
    ];
    // Вторая homework-задача — только в обычном/расширенном объёме (§2.3 v1).
    if (this.generator.maxBlocks(profile) >= 3) {
      const rotation = shelf.practiceRotation.filter((t): t is StudyTaskType =>
        ['mistakes', 'precision', 'drill', 'rated_game', 'puzzle_rush'].includes(t),
      );
      let best: StudyTaskType = rotation[0] ?? 'mistakes';
      let bestTime = Infinity;
      for (const type of rotation) {
        const used = profile.practiceLastUsedAt[type];
        const t = used ? used.getTime() : -1;
        if (t < bestTime) {
          bestTime = t;
          best = type;
        }
      }
      tasks.push({
        type: best,
        params: {},
        targetCount: best === 'rated_game' || best === 'puzzle_rush' ? 1 : 5,
      });
    }
    return tasks;
  }
}
