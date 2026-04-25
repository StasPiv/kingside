import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  LessonStepState,
  UserCoursePlayProgressDto,
  UserLessonPlayProgressDto,
} from '@kingside/shared';
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
 * В отличие от системного `ProgressService`, тут:
 *  - нет SM-2-записей (ADR-026 §7 — `LessonReview` к user-courses не
 *    подключаем; для «своих» курсов «к повторению» не имеет смысла);
 *  - счётчики компактные: `completedStepsCount/totalSteps` у урока и
 *    `completedLessonsCount` у курса. С KS-1879 рядом со счётчиком
 *    держим JSON-агрегат `stepsState` (`{ [stepId]: LessonStepState }`)
 *    — он обеспечивает идемпотентность `updateStepProgress` по `stepId`
 *    и восстановление UI-прогресса при повторном открытии урока;
 *    `completedStepsCount` пересчитывается как `count('done')` из этого
 *    объекта, а не отдельным инкрементом;
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
   * Отметить состояние шага (done/failed/skipped). Идемпотентно по
   * `stepId` (KS-1879):
   *  - state кладётся в `stepsState[stepId]` с upsert'ом;
   *  - `completedStepsCount` пересчитывается как количество `done` в
   *    `stepsState`, а не отдельным инкрементом — двойной POST `done`
   *    с тем же `stepId` → счётчик не растёт;
   *  - `failed`/`skipped` после `done` для того же шага честно
   *    «понижает» состояние и счётчик пересчитывается соответственно
   *    (контракт допускает обе стороны переходов; завершённый урок
   *    реально завершается отдельным `completeLesson`).
   *
   * Шаги, которых нет в `stepsState`, считаются `pending` по умолчанию
   * — фронт не обязан слать «pending» явно.
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

    const existing = await this.prisma.userLessonPlayProgress.findUnique({
      where: { userId_userLessonId: { userId, userLessonId } },
    });

    const prevStepsState = normalizeStepsState(existing?.stepsState);
    const nextStepsState: Record<string, LessonStepState> = {
      ...prevStepsState,
      [stepId]: state,
    };
    // Идемпотентность по stepId: счётчик — это count('done'), а не
    // инкремент. Дополнительно clamping до totalSteps как защита от
    // «осиротевших» stepId в JSON (например, шаг удалили автором).
    const doneCount = Object.values(nextStepsState).filter(
      (s) => s === 'done',
    ).length;
    const completedStepsCount = Math.min(doneCount, totalSteps);

    let row;
    if (!existing) {
      row = await this.prisma.userLessonPlayProgress.create({
        data: {
          userId,
          userLessonId,
          completedStepsCount,
          totalSteps,
          stepsState: nextStepsState,
          lastActivityAt: now,
        },
      });
    } else {
      row = await this.prisma.userLessonPlayProgress.update({
        where: { id: existing.id },
        data: {
          completedStepsCount,
          totalSteps,
          stepsState: nextStepsState,
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
   *
   * KS-1879: при завершении заполняем `stepsState` финальным снимком —
   * все известные `stepId` урока выставляем в `done` (с сохранением
   * пользовательских `failed`/`skipped`, если такие были — их не
   * перетираем, только pending-шаги становятся done). Это даёт фронту
   * корректный snapshot для отрисовки «всё пройдено» при повторном
   * открытии и согласует `count('done')` с `completedStepsCount`.
   */
  async completeLesson(
    userId: string,
    userLessonId: string,
    _score: number,
  ): Promise<UserLessonPlayProgressDto> {
    const lesson = await this.assertLessonAccessible(userId, userLessonId);

    const totalSteps = lesson.stepCount;
    const now = new Date();

    // Список stepId урока — нужен, чтобы записать в stepsState `done`
    // для всех шагов. Если шагов нет (пустой урок) — `stepsState`
    // останется как был.
    const steps = await this.prisma.userLessonStep.findMany({
      where: { userLessonId },
      select: { id: true },
    });

    // Проверяем, был ли урок уже завершён ДО апдейта — чтобы решить,
    // инкрементить ли counter курса.
    const before = await this.prisma.userLessonPlayProgress.findUnique({
      where: { userId_userLessonId: { userId, userLessonId } },
      select: { completedAt: true, stepsState: true },
    });
    const wasAlreadyCompleted = before?.completedAt != null;

    // Финальный snapshot: пользовательские failed/skipped не
    // перетираем (если ученик пометил шаг failed и всё-таки нажал
    // «Завершить» — UI решил, что в среднем порог пройден; снимать
    // факт failed не наше дело). Pending-шаги становятся done.
    const prev = normalizeStepsState(before?.stepsState);
    const finalStepsState: Record<string, LessonStepState> = { ...prev };
    for (const s of steps) {
      const cur = finalStepsState[s.id];
      if (cur !== 'failed' && cur !== 'skipped') {
        finalStepsState[s.id] = 'done';
      }
    }

    const row = await this.prisma.userLessonPlayProgress.upsert({
      where: { userId_userLessonId: { userId, userLessonId } },
      update: {
        completedStepsCount: totalSteps,
        totalSteps,
        stepsState: finalStepsState,
        completedAt: now,
        lastActivityAt: now,
      },
      create: {
        userId,
        userLessonId,
        completedStepsCount: totalSteps,
        totalSteps,
        stepsState: finalStepsState,
        completedAt: now,
        lastActivityAt: now,
      },
    });

    // KS-1881: для маркера «курс пройден» нужно знать актуальное число
    // уроков курса (учителю могли добавить/удалить урок между прогонами).
    // Считаем по `userLesson.count` — это источник правды; кэшированного
    // `lessonCount` на курсе у нас нет.
    const totalLessonsInCourse = await this.prisma.userLesson.count({
      where: { userCourseId: lesson.userCourseId },
    });

    await this.touchUserCourseProgress(userId, lesson.userCourseId, {
      incrementCompleted: !wasAlreadyCompleted,
      totalLessonsInCourse,
    });

    return toLessonPlayProgressDto(row);
  }

  /**
   * Обновляет `lastActivityAt` курса и (опционально) инкрементирует
   * `completedLessonsCount`. Прогресс курса создаётся лениво при первом
   * обращении (upsert), чтобы GET до старта прохождения мог честно
   * вернуть null, а первое движение инициировало запись.
   *
   * KS-1881: когда `totalLessonsInCourse` передан, после upsert'а
   * проверяем «весь курс пройден» (`completedLessonsCount >= total`)
   * и единожды выставляем `completedAt = now`. Идемпотентно — если
   * `completedAt` уже стоит, вторично не двигаем (timestamp фиксируется
   * на момент первого достижения 100%). Сброс `completedAt` при
   * добавлении нового урока выполняется в `UserCoursesService.addLesson`,
   * сюда логику reset'а не тащим — это другая ответственность.
   */
  async touchUserCourseProgress(
    userId: string,
    userCourseId: string,
    opts: { incrementCompleted: boolean; totalLessonsInCourse?: number },
  ): Promise<void> {
    const now = new Date();
    const row = await this.prisma.userCoursePlayProgress.upsert({
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

    // Маркер «курс пройден». Условия (все три):
    //  1. Передан `totalLessonsInCourse` (вызывающий знает фактическое
    //     число уроков и хочет, чтобы мы решили). `updateStepProgress`
    //     не передаёт — там не достижим переход в completed (только
    //     внутри `completeLesson` это происходит).
    //  2. Курс не пустой (`total > 0`) — у курса без уроков нет
    //     осмысленного «100%» состояния.
    //  3. Достигнут или превышен порог, и дата ещё не выставлена
    //     (идемпотентность: ставим один раз).
    const total = opts.totalLessonsInCourse;
    if (
      total !== undefined &&
      total > 0 &&
      row.completedLessonsCount >= total &&
      row.completedAt === null
    ) {
      await this.prisma.userCoursePlayProgress.update({
        where: { userId_userCourseId: { userId, userCourseId } },
        data: { completedAt: now },
      });
    }
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

