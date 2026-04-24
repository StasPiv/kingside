import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { LessonStepState, UserLessonProgress } from '@kingside/shared';
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

    const existing = await this.prisma.userLessonProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId } },
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
      where: { userId_lessonId: { userId, lessonId } },
      create: {
        userId,
        lessonId,
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

    return this.toShared(record);
  }

  /**
   * POST /api/lessons/progress/lesson/complete — закрыть урок если score ≥ порога.
   * `score` пришёл в 0..1 (shared), конвертируем в 0..100 для БД.
   */
  async completeLesson(
    userId: string,
    lessonId: string,
    scoreNormalized: number,
  ): Promise<UserLessonProgress> {
    if (scoreNormalized < 0 || scoreNormalized > 1) {
      throw new BadRequestException('score must be in [0, 1]');
    }
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, courseId: true },
    });
    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    const score100 = Math.round(scoreNormalized * 100);
    const completedAt = score100 >= this.COMPLETE_THRESHOLD ? new Date() : null;

    if (score100 < this.COMPLETE_THRESHOLD) {
      throw new BadRequestException(
        `Lesson not completed: score ${score100} below threshold ${this.COMPLETE_THRESHOLD}`,
      );
    }

    const existing = await this.prisma.userLessonProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId } },
    });

    const record = await this.prisma.userLessonProgress.upsert({
      where: { userId_lessonId: { userId, lessonId } },
      create: {
        userId,
        lessonId,
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
    if (score100 >= this.MASTER_THRESHOLD) {
      await this.sm2.markLessonMastered(userId, lessonId);
      const quality = Sm2Service.scoreToQuality(score100);
      await this.sm2.scheduleReview(userId, lessonId, quality);
    }

    return this.toShared(record);
  }

  /**
   * Создаёт/обновляет `UserCourseProgress.currentLessonId` — берёт его из
   * lesson.courseId, выставляет `startedAt` при первом обращении.
   * Если все уроки курса со `isPublished=true` завершены — ставит `completedAt`.
   */
  private async touchCourseProgress(userId: string, lessonId: string): Promise<void> {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { courseId: true },
    });
    if (!lesson) return;

    await this.prisma.userCourseProgress.upsert({
      where: { userId_courseId: { userId, courseId: lesson.courseId } },
      create: {
        userId,
        courseId: lesson.courseId,
        startedAt: new Date(),
        currentLessonId: lessonId,
      },
      update: {
        currentLessonId: lessonId,
      },
    });

    // Проверим, все ли опубликованные уроки курса пройдены
    const totalPublished = await this.prisma.lesson.count({
      where: { courseId: lesson.courseId, isPublished: true },
    });
    const completed = await this.prisma.userLessonProgress.count({
      where: {
        userId,
        completedAt: { not: null },
        lesson: { courseId: lesson.courseId, isPublished: true },
      },
    });
    if (totalPublished > 0 && completed >= totalPublished) {
      await this.prisma.userCourseProgress.update({
        where: { userId_courseId: { userId, courseId: lesson.courseId } },
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
