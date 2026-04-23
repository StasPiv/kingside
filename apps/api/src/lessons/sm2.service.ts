import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SM-2 (SuperMemo 2, Piotr Woźniak, 1987) — интервальное повторение
 * уроков раздела «Уроки». Источник истины — `docs/adr/025-lessons-sm2.md`.
 *
 * Единица повторения — урок целиком, не отдельный шаг/карточка
 * (ADR-025 §2.1). Запись в `LessonReview` создаётся при первом
 * прохождении урока со `score ≥ 80` (одновременно с `masteredAt`)
 * и обновляется после каждого следующего повтора.
 *
 * Маппинг `score` → `quality` и формулы — §2.1, §2.2 ADR-025.
 */
@Injectable()
export class Sm2Service {
  /** Минимальная граница коэффициента лёгкости (классический SM-2). */
  public static readonly MIN_EASINESS = 1.3;
  /** Стартовое значение EF для новой записи. */
  public static readonly INITIAL_EASINESS = 2.5;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Мапит агрегированный `score ∈ [0, 100]` в SM-2 quality `0..5`.
   * Таблица — ADR-025 §2.2.
   */
  static scoreToQuality(score100: number): number {
    if (score100 < 50) return 0;
    if (score100 < 60) return 2;
    if (score100 < 70) return 3;
    if (score100 < 80) return 3;
    if (score100 < 90) return 4;
    return 5;
  }

  /**
   * Пересчёт параметров SM-2 по формулам ADR-025 §2.1. Чистая функция —
   * отдельно от БД, чтобы удобно покрывать unit-тестами.
   *
   * @param prev — предыдущее состояние; если `null`, берётся стартовое
   *               (easiness=2.5, interval=1, repetitions=0).
   * @param quality — результат очередного повтора, 0..5.
   * @returns новое состояние; `dueAt` считается как `now + intervalNew дней`.
   */
  static applyReview(
    prev: { easiness: number; interval: number; repetitions: number } | null,
    quality: number,
    now: Date = new Date(),
  ): {
    easiness: number;
    interval: number;
    repetitions: number;
    dueAt: Date;
    lastQuality: number;
  } {
    const q = Math.max(0, Math.min(5, Math.trunc(quality)));
    const easinessPrev = prev?.easiness ?? Sm2Service.INITIAL_EASINESS;
    const repetitionsPrev = prev?.repetitions ?? 0;
    const intervalPrev = prev?.interval ?? 1;

    let repetitionsNew: number;
    let intervalNew: number;

    if (q < 3) {
      // Провал — серия сбрасывается, следующий повтор завтра.
      repetitionsNew = 0;
      intervalNew = 1;
    } else {
      if (repetitionsPrev === 0) {
        intervalNew = 1;
      } else if (repetitionsPrev === 1) {
        intervalNew = 6;
      } else {
        intervalNew = Math.max(1, Math.round(intervalPrev * easinessPrev));
      }
      repetitionsNew = repetitionsPrev + 1;
    }

    let easinessNew =
      easinessPrev + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    if (easinessNew < Sm2Service.MIN_EASINESS) {
      easinessNew = Sm2Service.MIN_EASINESS;
    }

    const dueAt = new Date(now.getTime() + intervalNew * 24 * 60 * 60 * 1000);

    return {
      easiness: easinessNew,
      interval: intervalNew,
      repetitions: repetitionsNew,
      dueAt,
      lastQuality: q,
    };
  }

  /**
   * Создаёт или обновляет `LessonReview` по алгоритму SM-2.
   * Вызывается из `ProgressService.completeLesson` при `score ≥ 80`
   * и при последующих повторах того же урока.
   */
  async scheduleReview(
    userId: string,
    lessonId: string,
    quality: number,
    now: Date = new Date(),
  ): Promise<{
    easiness: number;
    interval: number;
    repetitions: number;
    dueAt: Date;
  }> {
    const existing = await this.prisma.lessonReview.findUnique({
      where: { userId_lessonId: { userId, lessonId } },
    });

    const next = Sm2Service.applyReview(
      existing
        ? {
            easiness: existing.easiness,
            interval: existing.interval,
            repetitions: existing.repetitions,
          }
        : null,
      quality,
      now,
    );

    if (existing) {
      await this.prisma.lessonReview.update({
        where: { userId_lessonId: { userId, lessonId } },
        data: {
          easiness: next.easiness,
          interval: next.interval,
          repetitions: next.repetitions,
          dueAt: next.dueAt,
          lastReviewedAt: now,
          lastQuality: next.lastQuality,
        },
      });
    } else {
      await this.prisma.lessonReview.create({
        data: {
          userId,
          lessonId,
          easiness: next.easiness,
          interval: next.interval,
          repetitions: next.repetitions,
          dueAt: next.dueAt,
          lastReviewedAt: now,
          lastQuality: next.lastQuality,
        },
      });
    }

    return {
      easiness: next.easiness,
      interval: next.interval,
      repetitions: next.repetitions,
      dueAt: next.dueAt,
    };
  }

  /**
   * Список `lessonId`, у которых `dueAt <= date` для указанного
   * пользователя. Отдаётся в порядке `dueAt ASC` — первыми идут
   * самые «просроченные». Используется контроллером
   * `GET /api/lessons/reviews/due` и cron'ом.
   */
  async getDueReviews(userId: string, date: Date = new Date()): Promise<
    Array<{
      lessonId: string;
      dueAt: Date;
      interval: number;
      repetitions: number;
      easiness: number;
      lastReviewedAt: Date | null;
      lastQuality: number | null;
    }>
  > {
    const rows = await this.prisma.lessonReview.findMany({
      where: { userId, dueAt: { lte: date } },
      orderBy: { dueAt: 'asc' },
      select: {
        lessonId: true,
        dueAt: true,
        interval: true,
        repetitions: true,
        easiness: true,
        lastReviewedAt: true,
        lastQuality: true,
      },
    });
    return rows;
  }

  /**
   * Проставляет `UserLessonProgress.masteredAt` при первом прохождении
   * урока со `score ≥ 80`. Идемпотентно: повторные вызовы не меняют
   * уже установленное значение.
   *
   * @returns `true`, если метка была выставлена впервые (значит, можно
   *          создавать `LessonReview`), иначе `false`.
   */
  async markLessonMastered(
    userId: string,
    lessonId: string,
    at: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.prisma.userLessonProgress.updateMany({
      where: { userId, lessonId, masteredAt: null },
      data: { masteredAt: at },
    });
    return result.count > 0;
  }
}
