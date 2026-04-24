import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  UserCoursePlayProgressDto,
  UserLessonPlayProgressDto,
} from '@kingside/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { toCoursePlayProgressDto } from './user-courses.service';
import { toLessonPlayProgressDto } from './user-lessons.service';

/**
 * UserProgressService — прогресс прохождения пользовательских курсов
 * (ADR-026 §2.5, KS-1831).
 *
 * В отличие от системного `ProgressService`, тут:
 *  - нет SM-2-записей (ADR-026 §7 — `LessonReview` к user-courses не
 *    подключаем; для «своих» курсов «к повторению» не имеет смысла);
 *  - счётчики компактные: `completedStepsCount/totalSteps` у урока и
 *    `completedLessonsCount` у курса, без JSON-агрегата `stepsState`;
 *  - доступ: `owner ИЛИ isPublic` — играть можно и чужой публичный,
 *    но прогресс всегда привязан к `req.user.id`.
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

    const row = await this.prisma.userCoursePlayProgress.findUnique({
      where: { userId_userCourseId: { userId, userCourseId } },
    });
    return row ? toCoursePlayProgressDto(row) : null;
  }

  async getLessonProgress(
    userId: string,
    userLessonId: string,
  ): Promise<UserLessonPlayProgressDto | null> {
    await this.assertLessonAccessible(userId, userLessonId);

    const row = await this.prisma.userLessonPlayProgress.findUnique({
      where: { userId_userLessonId: { userId, userLessonId } },
    });
    return row ? toLessonPlayProgressDto(row) : null;
  }

  // ─── Write ────────────────────────────────────────────────────────

  /**
   * Отметить состояние шага (done/failed/skipped). В MVP храним только
   * счётчик `completedStepsCount` (без JSON-детализации `stepsState`
   * системного `UserLessonProgress` — для user-courses достаточно
   * счётчика для прогресс-бара; если позже понадобится детализация —
   * добавим отдельно).
   *
   * Идемпотентность: один и тот же `done` дважды подряд НЕ удваивает
   * счётчик — clamping'ом до `totalSteps`. Но гарантировать «уникальный
   * stepId» без доп. структуры мы не можем: клиент, отправивший
   * два разных stepId из одного урока с состоянием `done`, честно
   * получит +2 к счётчику. Это ожидаемое поведение для MVP.
   */
  async updateStepProgress(
    userId: string,
    userLessonId: string,
    _stepId: string,
    state: 'done' | 'failed' | 'skipped',
  ): Promise<UserLessonPlayProgressDto> {
    const lesson = await this.assertLessonAccessible(userId, userLessonId);

    const totalSteps = lesson.stepCount;
    const now = new Date();

    const existing = await this.prisma.userLessonPlayProgress.findUnique({
      where: { userId_userLessonId: { userId, userLessonId } },
    });

    let row;
    if (!existing) {
      row = await this.prisma.userLessonPlayProgress.create({
        data: {
          userId,
          userLessonId,
          completedStepsCount: state === 'done' ? 1 : 0,
          totalSteps,
          lastActivityAt: now,
        },
      });
    } else {
      const completed =
        state === 'done'
          ? Math.min(existing.completedStepsCount + 1, totalSteps)
          : existing.completedStepsCount;
      row = await this.prisma.userLessonPlayProgress.update({
        where: { id: existing.id },
        data: {
          completedStepsCount: completed,
          totalSteps,
          lastActivityAt: now,
        },
      });
    }

    // Обновляем lastActivityAt курса — чтобы «мои курсы» сортировались
    // по активности, а не только по edit'ам автора.
    await this.touchUserCourseProgress(userId, lesson.userCourseId, {
      incrementCompleted: false,
    });

    return toLessonPlayProgressDto(row);
  }

  /**
   * Пометить урок завершённым. Идемпотентно: повторный POST с
   * `completedAt !== null` НЕ инкрементирует счётчик курса повторно.
   *
   * Порог (score >= X) в MVP не enforced — доверяем клиенту. Серверный
   * threshold-гейт можно добавить позже, когда будет продуктовое
   * требование.
   */
  async completeLesson(
    userId: string,
    userLessonId: string,
    _score: number,
  ): Promise<UserLessonPlayProgressDto> {
    const lesson = await this.assertLessonAccessible(userId, userLessonId);

    const totalSteps = lesson.stepCount;
    const now = new Date();

    // Проверяем, был ли урок уже завершён ДО апдейта — чтобы решить,
    // инкрементить ли counter курса.
    const before = await this.prisma.userLessonPlayProgress.findUnique({
      where: { userId_userLessonId: { userId, userLessonId } },
      select: { completedAt: true },
    });
    const wasAlreadyCompleted = before?.completedAt != null;

    const row = await this.prisma.userLessonPlayProgress.upsert({
      where: { userId_userLessonId: { userId, userLessonId } },
      update: {
        completedStepsCount: totalSteps,
        totalSteps,
        completedAt: now,
        lastActivityAt: now,
      },
      create: {
        userId,
        userLessonId,
        completedStepsCount: totalSteps,
        totalSteps,
        completedAt: now,
        lastActivityAt: now,
      },
    });

    await this.touchUserCourseProgress(userId, lesson.userCourseId, {
      incrementCompleted: !wasAlreadyCompleted,
    });

    return toLessonPlayProgressDto(row);
  }

  /**
   * Обновляет `lastActivityAt` курса и (опционально) инкрементирует
   * `completedLessonsCount`. Прогресс курса создаётся лениво при первом
   * обращении (upsert), чтобы GET до старта прохождения мог честно
   * вернуть null, а первое движение инициировало запись.
   */
  async touchUserCourseProgress(
    userId: string,
    userCourseId: string,
    opts: { incrementCompleted: boolean },
  ): Promise<void> {
    const now = new Date();
    await this.prisma.userCoursePlayProgress.upsert({
      where: { userId_userCourseId: { userId, userCourseId } },
      update: {
        lastActivityAt: now,
        ...(opts.incrementCompleted
          ? { completedLessonsCount: { increment: 1 } }
          : {}),
      },
      create: {
        userId,
        userCourseId,
        completedLessonsCount: opts.incrementCompleted ? 1 : 0,
        lastActivityAt: now,
      },
    });
  }

  // ─── Access helpers ──────────────────────────────────────────────

  /**
   * Проверяет, что курс существует и доступен пользователю (owner ИЛИ
   * isPublic). Кидает 404 при отказе — единый код по ADR-026 §2.5.
   */
  private async assertCourseAccessible(
    userId: string,
    userCourseId: string,
  ): Promise<{ ownerId: string; isPublic: boolean }> {
    const course = await this.prisma.userCourse.findUnique({
      where: { id: userCourseId },
      select: { ownerId: true, isPublic: true },
    });
    if (!course) throw new NotFoundException('Resource not found');
    if (course.ownerId !== userId && !course.isPublic) {
      // 404 (не 403) — enumeration protection.
      throw new NotFoundException('Resource not found');
    }
    return course;
  }

  /**
   * Проверяет, что урок существует и доступен пользователю. Возвращает
   * `{userCourseId, stepCount}` — оба нужны в вызовах выше.
   */
  private async assertLessonAccessible(
    userId: string,
    userLessonId: string,
  ): Promise<{ userCourseId: string; stepCount: number }> {
    const lesson = await this.prisma.userLesson.findUnique({
      where: { id: userLessonId },
      include: {
        _count: { select: { steps: true } },
        course: { select: { ownerId: true, isPublic: true } },
      },
    });
    if (!lesson) throw new NotFoundException('Resource not found');
    if (lesson.course.ownerId !== userId && !lesson.course.isPublic) {
      throw new NotFoundException('Resource not found');
    }
    return {
      userCourseId: lesson.userCourseId,
      stepCount: lesson._count.steps,
    };
  }
}

