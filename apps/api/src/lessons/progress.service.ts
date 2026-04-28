import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CompleteLessonResponse,
  LessonStepState,
  UserLessonProgress,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { Sm2Service } from './sm2.service';
import { ADAPTIVE_STATE_KEY } from './adaptive-difficulty.service';

/**
 * Политика прогресса (ADR-024 §2.3, ADR-025):
 *  - Шаг: done / failed / skipped / pending / in_progress.
 *  - Урок «пройден»: score ≥ 70 (на 100-балльной шкале в БД) => `completedAt`.
 *    Порог в shared — 0.7 (0..1).
 *  - Урок «освоен» (SM-2): score ≥ 80 => `masteredAt` + запись
 *    в `LessonReview` через `Sm2Service` (L-21).
 *
 * Попытки задач внутри `PuzzleStep` фиксируются в существующей таблице
 * `PuzzleAttempt` (PuzzleService) — здесь дублировать их не нужно. В
 * `stepsState` храним только агрегат (done / failed / skipped).
 */
@Injectable()
export class ProgressService {
  private readonly COMPLETE_THRESHOLD = 70; // 0..100, соответствует 0.7 в shared-типах
  private readonly MASTER_THRESHOLD = 80; // 0..100, ADR-025 §2.5

  constructor(
    private readonly prisma: PrismaService,
    private readonly sm2: Sm2Service,
  ) {}

  /**
   * KS-2095: резолвит `effectiveLessonId` — root-id урока. Прогресс
   * пользователя пишется и читается только по root-id, чтобы переключение
   * языка (RU↔EN) не сбрасывало прогресс. Локальные lessonId (для EN-
   * варианта) приходят в API, но для записи в БД они переводятся в root.
   */
  private async resolveLessonRootId(lessonId: string): Promise<string> {
    const row = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, parentLessonId: true },
    });
    if (!row) {
      throw new NotFoundException('Lesson not found');
    }
    return row.parentLessonId ?? row.id;
  }

  /** POST /api/lessons/progress/step — upsert состояния одного шага. */
  async updateStep(
    userId: string,
    lessonId: string,
    stepId: string,
    state: LessonStepState,
  ): Promise<UserLessonProgress> {
    // убедимся, что урок существует и шаг ему принадлежит
    const step = await this.prisma.lessonStep.findUnique({
      where: { id: stepId },
      select: { id: true, lessonId: true },
    });
    if (!step || step.lessonId !== lessonId) {
      throw new NotFoundException('Step not found in lesson');
    }

    // KS-2095: прогресс пишем по root-id (единый между языковыми вариантами).
    const rootLessonId = await this.resolveLessonRootId(lessonId);

    const existing = await this.prisma.userLessonProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId: rootLessonId } },
    });

    // Сохраняем служебные ключи (`__adaptive` от KS-1803) при merge —
    // `stepsState` в БД хранит и доменные статусы шагов, и внутренние
    // данные адаптивной сложности. Тип делаем `unknown`, чтобы не обещать
    // что все значения — `LessonStepState`.
    const stepsState: Record<string, unknown> = {
      ...((existing?.stepsState as Record<string, unknown> | undefined) ?? {}),
      [stepId]: state,
    };

    const record = await this.prisma.userLessonProgress.upsert({
      where: { userId_lessonId: { userId, lessonId: rootLessonId } },
      create: {
        userId,
        lessonId: rootLessonId,
        startedAt: new Date(),
        score: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stepsState: stepsState as any,
      },
      update: {
        // startedAt оставляем как был
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stepsState: stepsState as any,
      },
    });

    await this.touchCourseProgress(userId, lessonId);

    // KS-2095: возвращаем фронту локальный lessonId, который он прислал —
    // фронт оперирует UI-сторонним id текущего языка. БД хранит root,
    // но клиенту это знать не обязательно.
    return this.toShared({ ...record, lessonId });
  }

  /**
   * POST /api/lessons/progress/lesson/complete — закрыть урок если score ≥ порога.
   * `score` пришёл в 0..1 (shared), конвертируем в 0..100 для БД.
   */
  async completeLesson(
    userId: string,
    lessonId: string,
    scoreNormalized: number,
    quality?: number,
  ): Promise<CompleteLessonResponse> {
    if (scoreNormalized < 0 || scoreNormalized > 1) {
      throw new BadRequestException('score must be in [0, 1]');
    }
    if (quality !== undefined && (quality < 0 || quality > 5 || !Number.isFinite(quality))) {
      throw new BadRequestException('quality must be an integer in [0, 5]');
    }
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, courseId: true, parentLessonId: true },
    });
    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    // KS-2095: пишем по root-id урока.
    const rootLessonId = lesson.parentLessonId ?? lesson.id;

    const score100 = Math.round(scoreNormalized * 100);
    const completedAt = score100 >= this.COMPLETE_THRESHOLD ? new Date() : null;

    if (score100 < this.COMPLETE_THRESHOLD) {
      throw new BadRequestException(
        `Lesson not completed: score ${score100} below threshold ${this.COMPLETE_THRESHOLD}`,
      );
    }

    const existing = await this.prisma.userLessonProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId: rootLessonId } },
    });

    const record = await this.prisma.userLessonProgress.upsert({
      where: { userId_lessonId: { userId, lessonId: rootLessonId } },
      create: {
        userId,
        lessonId: rootLessonId,
        startedAt: new Date(),
        completedAt,
        score: score100,
        stepsState: (existing?.stepsState as object | undefined) ?? {},
      },
      update: {
        completedAt,
        score: score100,
      },
    });

    await this.touchCourseProgress(userId, lessonId);

    // ─── SM-2 повторения (ADR-025 §2.5): только для score ≥ 80. ─────
    // `markLessonMastered` идемпотентен: `masteredAt` выставляется
    // только в первый раз (updateMany с `masteredAt: null`).
    // `scheduleReview` вызывается и при первом «освоении», и при
    // каждом последующем повторе — обновляет параметры SM-2.
    // KS-2095: SM-2 пишем по root-id (общий между языками).
    const baseResponse: CompleteLessonResponse = this.toShared({
      ...record,
      lessonId,
    });
    if (score100 >= this.MASTER_THRESHOLD) {
      await this.sm2.markLessonMastered(userId, rootLessonId);
      // L-22 / KS-1809: если клиент передал явный `quality` (UI повторений:
      // кнопки 0..5), используем его; иначе — классический маппинг из score.
      const q = quality ?? Sm2Service.scoreToQuality(score100);
      const review = await this.sm2.scheduleReview(userId, rootLessonId, q);
      baseResponse.nextDueAt = review.dueAt.toISOString();
      baseResponse.intervalDays = review.interval;
      baseResponse.easeFactor = review.easiness;
    }

    return baseResponse;
  }

  /**
   * Создаёт/обновляет `UserCourseProgress.currentLessonId` — берёт его из
   * lesson.courseId, выставляет `startedAt` при первом обращении.
   * Если все уроки курса со `isPublished=true` завершены — ставит `completedAt`.
   */
  private async touchCourseProgress(userId: string, lessonId: string): Promise<void> {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: {
        courseId: true,
        parentLessonId: true,
        course: { select: { parentCourseId: true } },
      },
    });
    if (!lesson) return;

    // KS-2095: прогресс курса хранится по root-id курса. currentLessonId
    // и connectivity-чек тоже считаются по root.
    const rootCourseId = lesson.course.parentCourseId ?? lesson.courseId;
    const rootLessonId = lesson.parentLessonId ?? lessonId;

    await this.prisma.userCourseProgress.upsert({
      where: { userId_courseId: { userId, courseId: rootCourseId } },
      create: {
        userId,
        courseId: rootCourseId,
        startedAt: new Date(),
        currentLessonId: rootLessonId,
      },
      update: {
        currentLessonId: rootLessonId,
      },
    });

    // KS-2095: проверка завершённости курса. Считаем по уроком root-курса
    // (это RU-эталон). Если у root-курса все опубликованные уроки пройдены,
    // курс completed. Используем lessonId по root для join'а на
    // userLessonProgress.
    const totalPublished = await this.prisma.lesson.count({
      where: { courseId: rootCourseId, isPublished: true },
    });
    const completed = await this.prisma.userLessonProgress.count({
      where: {
        userId,
        completedAt: { not: null },
        lesson: { courseId: rootCourseId, isPublished: true },
      },
    });
    if (totalPublished > 0 && completed >= totalPublished) {
      await this.prisma.userCourseProgress.update({
        where: { userId_courseId: { userId, courseId: rootCourseId } },
        data: { completedAt: new Date() },
      });
    }
  }

  private toShared(row: {
    userId: string;
    lessonId: string;
    startedAt: Date;
    completedAt: Date | null;
    score: number;
    stepsState: unknown;
  }): UserLessonProgress {
    return {
      userId: row.userId,
      lessonId: row.lessonId,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      score: row.score / 100,
      stepsState: stripInternalKeys(row.stepsState),
    };
  }
}

/**
 * Убирает служебные ключи (`__adaptive`, см. KS-1803) из `stepsState`
 * перед отдачей клиенту. Public-контракт `UserLessonProgress.stepsState`
 * — это `Record<string, LessonStepState>`, где значения — строковые
 * состояния шагов. Служебные данные адаптивной сложности хранятся в той
 * же JSONB-колонке, но под отдельным ключом, и не должны просачиваться
 * наружу.
 */
function stripInternalKeys(raw: unknown): Record<string, LessonStepState> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, LessonStepState> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === ADAPTIVE_STATE_KEY) continue;
    // Только строковые значения — валидные `LessonStepState`-ы.
    if (typeof v === 'string') {
      out[k] = v as LessonStepState;
    }
  }
  return out;
}
