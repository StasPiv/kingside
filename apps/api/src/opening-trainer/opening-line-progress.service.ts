import { Injectable, Logger } from '@nestjs/common';
import { OPENING_LINE_MASTERY_THRESHOLD } from '@kingside/shared';
import { Sm2Service } from '../lessons/sm2.service';
import { OpeningTrainerRepository } from './opening-trainer.repository';
import { pathHash } from './path-hash';

/**
 * KS-3288 (M2 §2.5 ADR-077). Per-path прогресс пользователя по линиям
 * репертуара — counter подряд правильных, mastered-флаг, SM-2 init.
 *
 * Вызывается из `OpeningTrainerService.makeMove` (KS-3289 B3) на каждый
 * user-attempt (correct / wrong), КРОМЕ режима `free` (§2.7: «свободная
 * прогонка без обновления статистики»).
 *
 * **Mastery flow**:
 *   - При `consecutiveCorrect >= 3` (`OPENING_LINE_MASTERY_THRESHOLD`)
 *     и `masteredAt IS NULL` → переход в mastered.
 *   - В этот момент инициализируется SM-2 через `Sm2Service.applyReview`
 *     с `quality=5` (новая мастеринг-инициализация). Записываем
 *     `sm2Easiness`, `sm2Interval`, `sm2DueAt`, `sm2Reps`.
 *
 * **SM-2 для review-режима**: дальнейшие обновления SM-2 идут в KS-3290
 * (B4) `applyReviewResult(quality)`:
 *   - clean line-complete → quality=5 (extends interval).
 *   - wrong на review-линии → quality=1 (resets interval).
 * Маппинг `correct=2` НЕ используется (q<3 всегда reset'ит, не годится
 * для штатных correct'ов). Прямой `recordAttempt` НЕ дёргает SM-2
 * после mastery; только B4 review-handler.
 *
 * **Orphan**: если линия orphaned=true (после rebuild PGN, B8),
 * `recordAttempt` не апдейтит её — линия из старого дерева, новых
 * проходов по ней быть не может. Это soft-guarantee — если PATCH PGN
 * проходит с старой линией всё ещё в дереве (resurrect), orphaned
 * становится false и обновление возобновляется.
 */
@Injectable()
export class OpeningLineProgressService {
  private readonly logger = new Logger(OpeningLineProgressService.name);

  constructor(private readonly repo: OpeningTrainerRepository) {}

  /**
   * Записать один user-attempt. Возвращает обновлённую запись прогресса
   * (или null, если skip из-за orphan/free-mode — caller отвечает за
   * free-mode skip, тут не проверяем).
   */
  async recordAttempt(input: {
    userId: string;
    repertoireId: string;
    pathUci: ReadonlyArray<string>;
    correct: boolean;
    now?: Date;
  }) {
    const { userId, repertoireId, pathUci, correct } = input;
    const now = input.now ?? new Date();
    const hash = pathHash(pathUci);

    const existing = await this.repo.findLineProgress(
      userId,
      repertoireId,
      hash,
    );

    // Orphan-skip: не апдейтим устарелые записи.
    if (existing?.orphaned) {
      this.logger.log(
        `[line-progress] skip orphan path: user=${userId.slice(0, 8)} rep=${repertoireId.slice(0, 8)} hash=${hash.slice(0, 8)}`,
      );
      return existing;
    }

    const correctCountPrev = existing?.correctCount ?? 0;
    const wrongCountPrev = existing?.wrongCount ?? 0;
    const consecPrev = existing?.consecutiveCorrect ?? 0;
    const masteredPrev = existing?.masteredAt ?? null;

    const correctCount = correct ? correctCountPrev + 1 : correctCountPrev;
    const wrongCount = correct ? wrongCountPrev : wrongCountPrev + 1;
    const consecutiveCorrect = correct ? consecPrev + 1 : 0;

    // Mastery: 3 подряд + ещё не mastered → инициализируем SM-2.
    let masteredAt: Date | null = masteredPrev;
    let sm2Easiness: number | null = existing?.sm2Easiness ?? null;
    let sm2Interval: number | null = existing?.sm2Interval ?? null;
    let sm2DueAt: Date | null = existing?.sm2DueAt ?? null;
    let sm2Reps: number | null = existing?.sm2Reps ?? null;

    const justMastered =
      consecutiveCorrect >= OPENING_LINE_MASTERY_THRESHOLD &&
      masteredPrev === null;
    if (justMastered) {
      masteredAt = now;
      // `quality=5` — новая мастеринг-инициализация (SM-2 чистый старт).
      const sm2 = Sm2Service.applyReview(null, 5, now);
      sm2Easiness = sm2.easiness;
      sm2Interval = sm2.interval;
      sm2DueAt = sm2.dueAt;
      sm2Reps = sm2.repetitions;
      this.logger.log(
        `[line-progress] mastered: user=${userId.slice(0, 8)} rep=${repertoireId.slice(0, 8)} ` +
          `hash=${hash.slice(0, 8)} interval=${sm2Interval}d due=${sm2DueAt.toISOString().slice(0, 10)}`,
      );
    }

    return this.repo.upsertLineProgress(
      userId,
      repertoireId,
      hash,
      {
        pathUci: pathUci.slice(),
        pathLength: pathUci.length,
        lastPlayedAt: now,
        correctCount,
        wrongCount,
        consecutiveCorrect,
        masteredAt,
        sm2Easiness,
        sm2Interval,
        sm2DueAt,
        sm2Reps,
        orphaned: false,
      },
      {
        lastPlayedAt: now,
        correctCount,
        wrongCount,
        consecutiveCorrect,
        masteredAt,
        sm2Easiness,
        sm2Interval,
        sm2DueAt,
        sm2Reps,
        // orphaned не апдейтим — управляется отдельно через markOrphans.
      },
    );
  }

  /**
   * KS-3290 (B4) review-handler. После прохождения review-линии:
   *   - clean (без ошибок в этом проходе) → quality=5 (extends).
   *   - wrong → quality=1 (resets to 1 day).
   *
   * SM-2 применяется к существующему prev-state и сохраняется в
   * sm2_*-поля. masteredAt НЕ трогаем (линия уже была mastered;
   * review проход не сбрасывает мастеринг даже при wrong).
   */
  async applyReviewResult(input: {
    userId: string;
    repertoireId: string;
    pathUci: ReadonlyArray<string>;
    quality: 1 | 5;
    now?: Date;
  }) {
    const { userId, repertoireId, pathUci, quality } = input;
    const now = input.now ?? new Date();
    const hash = pathHash(pathUci);
    const existing = await this.repo.findLineProgress(
      userId,
      repertoireId,
      hash,
    );
    if (!existing) {
      this.logger.warn(
        `[line-progress] applyReviewResult: no row for hash=${hash.slice(0, 8)}`,
      );
      return null;
    }
    if (existing.orphaned) {
      return existing;
    }
    const prev = existing.sm2Easiness !== null
      ? {
          easiness: existing.sm2Easiness,
          interval: existing.sm2Interval ?? 1,
          repetitions: existing.sm2Reps ?? 0,
        }
      : null;
    const sm2 = Sm2Service.applyReview(prev, quality, now);
    return this.repo.upsertLineProgress(
      userId,
      repertoireId,
      hash,
      {
        pathUci: pathUci.slice(),
        pathLength: pathUci.length,
        lastPlayedAt: now,
        correctCount: existing.correctCount,
        wrongCount: existing.wrongCount,
        consecutiveCorrect: existing.consecutiveCorrect,
        masteredAt: existing.masteredAt,
        sm2Easiness: sm2.easiness,
        sm2Interval: sm2.interval,
        sm2DueAt: sm2.dueAt,
        sm2Reps: sm2.repetitions,
        orphaned: false,
      },
      {
        lastPlayedAt: now,
        sm2Easiness: sm2.easiness,
        sm2Interval: sm2.interval,
        sm2DueAt: sm2.dueAt,
        sm2Reps: sm2.repetitions,
      },
    );
  }
}
