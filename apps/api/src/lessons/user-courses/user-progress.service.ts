import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  LessonStepState,
  UserCoursePlayProgressDto,
  UserLessonPlayProgressDto,
} from '@kingside/shared';
import { USER_LESSON_COMPLETION_THRESHOLD } from '@kingside/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { toCoursePlayProgressDto } from './user-courses.service';
import {
  normalizeStepsState,
  toLessonPlayProgressDto,
} from './user-lessons.service';

/**
 * UserProgressService — прогресс прохождения пользовательских курсов
 * (ADR-026 §2.5, KS-1831).
 *
 * KS-2648 / ADR-054 Phase E2. Сервис переключён на единые таблицы:
 *   * `prisma.userCourseProgress` (системная) — вместо
 *     `prisma.userCoursePlayProgress`.
 *   * `prisma.userLessonProgress` — вместо `userLessonPlayProgress`.
 *   * `prisma.lesson` / `prisma.lessonStep` — вместо `userLesson`/
 *     `userLessonStep`.
 *
 * Системные таблицы прогресса не хранят `completedLessonsCount` /
 * `completedStepsCount` / `totalSteps` — мы их вычисляем on-demand:
 *   * `completedStepsCount` = count('done') в `stepsState` (это и
 *     раньше было идемпотентным счётчиком, KS-1879);
 *   * `completedLessonsCount` = count(userLessonProgress where userId,
 *     lessonId in уроки курса, completedAt != null);
 *   * `totalSteps` = `_count.steps` через include или отдельным
 *     `count`.
 *
 * Маркер «курс пройден» (`courseProgress.completedAt`) ставится в
 * `touchUserCourseProgress` после фактической проверки «все уроки
 * курса завершены» — без хранимого счётчика.
 *
 * В отличие от системного `ProgressService`, тут:
 *  - нет SM-2-записей (ADR-054 §3.2 п.7 — `LessonReview` к
 *    пользовательским курсам не подключаем);
 *  - доступ: `owner ИЛИ isPublic` — играть можно и чужой публичный.
 *
 * Контракт 404: если урок/курс не существует или приватный чужой,
 * отвечаем 404 (единый код, ADR-026 §2.5 — защита от enumeration).
 */
@Injectable()
export class UserProgressService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Read ─────────────────────────────────────────────────────────

  async getCourseProgress(
    userId: string,
    userCourseId: string,
  ): Promise<UserCoursePlayProgressDto | null> {
    await this.assertCourseAccessible(userId, userCourseId);

    const row = await this.prisma.userCourseProgress.findUnique({
      where: { userId_courseId: { userId, courseId: userCourseId } },
    });
    if (!row) return null;

    // KS-1955 + KS-2648: уроки курса для подсчёта completed-stat'ов.
    const lessons = await this.prisma.lesson.findMany({
      where: { courseId: userCourseId },
      orderBy: { order: 'asc' },
      select: { id: true, order: true, title: true },
    });
    let currentLesson: { slug: string; title: string; order: number } | null =
      null;
    let completedLessonsCount = 0;
    if (lessons.length > 0) {
      const lessonIds = lessons.map((l) => l.id);
      const progressRows = await this.prisma.userLessonProgress.findMany({
        where: { userId, lessonId: { in: lessonIds } },
        select: { lessonId: true, completedAt: true },
      });
      const completedSet = new Set(
        progressRows
          .filter((p) => p.completedAt != null)
          .map((p) => p.lessonId),
      );
      completedLessonsCount = completedSet.size;
      const idx = lessons.findIndex((l) => !completedSet.has(l.id));
      if (idx >= 0) {
        currentLesson = {
          slug: lessons[idx].id,
          title: lessons[idx].title ?? '',
          order: idx + 1,
        };
      }
    }

    return toCoursePlayProgressDto(
      {
        courseId: row.courseId,
        startedAt: row.startedAt,
        updatedAt: row.updatedAt,
        completedAt: row.completedAt,
      },
      { completedLessonsCount, currentLesson },
    );
  }

  async getLessonProgress(
    userId: string,
    userLessonId: string,
  ): Promise<UserLessonPlayProgressDto | null> {
    const lesson = await this.assertLessonAccessible(userId, userLessonId);

    const row = await this.prisma.userLessonProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId: userLessonId } },
    });
    return row ? toLessonPlayProgressDto(row, lesson.stepCount) : null;
  }

  // ─── Write ────────────────────────────────────────────────────────

  /**
   * Отметить состояние шага. Идемпотентно по `stepId` (KS-1879).
   *
   * KS-2648: запись в `user_lesson_progress` — системная таблица. Поля
   * `completedStepsCount`/`totalSteps` в ней не хранятся, считаются
   * on-demand (см. `toLessonPlayProgressDto`). Из write-set'а они
   * убраны.
   */
  async updateStepProgress(
    userId: string,
    userLessonId: string,
    stepId: string,
    state: 'done' | 'failed' | 'skipped',
  ): Promise<UserLessonPlayProgressDto> {
    const lesson = await this.assertLessonAccessible(userId, userLessonId);

    const totalSteps = lesson.stepCount;
    const now = new Date();

    const existing = await this.prisma.userLessonProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId: userLessonId } },
    });

    const prevStepsState = normalizeStepsState(existing?.stepsState);
    const nextStepsState: Record<string, LessonStepState> = {
      ...prevStepsState,
      [stepId]: state,
    };

    let row;
    if (!existing) {
      row = await this.prisma.userLessonProgress.create({
        data: {
          userId,
          lessonId: userLessonId,
          score: 0,
          stepsState: nextStepsState,
          // updatedAt в Prisma ставится автоматически через @updatedAt,
          // но т.к. ниже мы хотим единый now-timestamp с курсовой
          // touch-операцией — ставим явно.
          updatedAt: now,
        },
      });
    } else {
      row = await this.prisma.userLessonProgress.update({
        where: { id: existing.id },
        data: {
          stepsState: nextStepsState,
          updatedAt: now,
        },
      });
    }

    await this.touchUserCourseProgress(userId, lesson.courseId, {
      checkAllDone: false,
    });

    return toLessonPlayProgressDto(row, totalSteps);
  }

  /**
   * Пометить урок завершённым. Идемпотентно.
   */
  async completeLesson(
    userId: string,
    userLessonId: string,
    _score: number,
  ): Promise<UserLessonPlayProgressDto> {
    const lesson = await this.assertLessonAccessible(userId, userLessonId);

    const totalSteps = lesson.stepCount;
    const now = new Date();

    const steps = await this.prisma.lessonStep.findMany({
      where: { lessonId: userLessonId },
      select: { id: true },
    });

    const before = await this.prisma.userLessonProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId: userLessonId } },
      select: { completedAt: true, stepsState: true },
    });
    const wasAlreadyCompleted = before?.completedAt != null;

    // KS-1883 порог.
    const prevStepsState = normalizeStepsState(before?.stepsState);
    if (!wasAlreadyCompleted && totalSteps > 0) {
      const doneCount = Object.values(prevStepsState).filter(
        (s) => s === 'done',
      ).length;
      const serverScore = doneCount / totalSteps;
      if (serverScore < USER_LESSON_COMPLETION_THRESHOLD) {
        const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
        throw new BadRequestException(
          `Lesson not completable: server score ${pct(serverScore)} ` +
            `(${doneCount}/${totalSteps}) is below threshold ` +
            `${pct(USER_LESSON_COMPLETION_THRESHOLD)}`,
        );
      }
    }

    const finalStepsState: Record<string, LessonStepState> = {
      ...prevStepsState,
    };
    for (const s of steps) {
      const cur = finalStepsState[s.id];
      if (cur !== 'failed' && cur !== 'skipped') {
        finalStepsState[s.id] = 'done';
      }
    }

    const row = await this.prisma.userLessonProgress.upsert({
      where: { userId_lessonId: { userId, lessonId: userLessonId } },
      update: {
        stepsState: finalStepsState,
        completedAt: now,
        updatedAt: now,
      },
      create: {
        userId,
        lessonId: userLessonId,
        score: 0,
        stepsState: finalStepsState,
        completedAt: now,
        updatedAt: now,
      },
    });

    // KS-2648: маркер «курс пройден» теперь проверяем фактически —
    // считаем completed-уроки on-demand. Передаём `checkAllDone: true`,
    // чтобы touch проверил.
    await this.touchUserCourseProgress(userId, lesson.courseId, {
      checkAllDone: true,
    });

    return toLessonPlayProgressDto(row, totalSteps);
  }

  /**
   * Обновляет `updatedAt` курса (lastActivityAt в DTO). Прогресс курса
   * создаётся лениво (upsert).
   *
   * KS-2648: счётчик `completedLessonsCount` в системной таблице
   * отсутствует. Маркер «курс пройден» ставим после фактической
   * проверки: сравниваем кол-во `userLessonProgress.completedAt!=null`
   * с числом уроков курса. Идемпотентность та же — `completedAt`
   * выставляется только если ранее был `null`.
   */
  async touchUserCourseProgress(
    userId: string,
    userCourseId: string,
    opts: { checkAllDone: boolean },
  ): Promise<void> {
    const now = new Date();
    await this.prisma.userCourseProgress.upsert({
      where: { userId_courseId: { userId, courseId: userCourseId } },
      update: { updatedAt: now },
      create: {
        userId,
        courseId: userCourseId,
        updatedAt: now,
      },
    });

    if (!opts.checkAllDone) return;

    // Считаем completed-уроки фактически.
    const lessons = await this.prisma.lesson.findMany({
      where: { courseId: userCourseId },
      select: { id: true },
    });
    if (lessons.length === 0) return;
    const lessonIds = lessons.map((l) => l.id);
    const completedCount = await this.prisma.userLessonProgress.count({
      where: {
        userId,
        lessonId: { in: lessonIds },
        completedAt: { not: null },
      },
    });
    if (completedCount < lessons.length) return;

    // Все уроки пройдены: ставим completedAt у курса (один раз).
    await this.prisma.userCourseProgress.updateMany({
      where: {
        userId,
        courseId: userCourseId,
        completedAt: null,
      },
      data: { completedAt: now },
    });
  }

  // ─── Access helpers ──────────────────────────────────────────────

  private async assertCourseAccessible(
    userId: string,
    userCourseId: string,
  ): Promise<{ ownerId: string | null; isPublic: boolean }> {
    const course = await this.prisma.course.findUnique({
      where: { id: userCourseId },
      select: { ownerId: true, isPublic: true },
    });
    if (!course) throw new NotFoundException('Resource not found');
    // KS-2648: системные курсы (ownerId IS NULL) не должны попадать в
    // user-progress flow.
    if (course.ownerId === null) {
      throw new NotFoundException('Resource not found');
    }
    if (course.ownerId !== userId && !course.isPublic) {
      throw new NotFoundException('Resource not found');
    }
    return course;
  }

  /**
   * Возвращает `{courseId, stepCount}` пользовательского урока.
   */
  private async assertLessonAccessible(
    userId: string,
    userLessonId: string,
  ): Promise<{ courseId: string; stepCount: number }> {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: userLessonId },
      include: {
        _count: { select: { steps: true } },
        course: { select: { ownerId: true, isPublic: true } },
      },
    });
    if (!lesson) throw new NotFoundException('Resource not found');
    if (lesson.course.ownerId === null) {
      // Системный урок не относится к user-progress flow.
      throw new NotFoundException('Resource not found');
    }
    if (lesson.course.ownerId !== userId && !lesson.course.isPublic) {
      throw new NotFoundException('Resource not found');
    }
    return {
      courseId: lesson.courseId,
      stepCount: lesson._count.steps,
    };
  }
}
