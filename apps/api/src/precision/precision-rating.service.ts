/**
 * KS-3343 / ADR-079 §3.6. Сервис обновления Precision-рейтинга
 * после успешной записи `PrecisionAttempt`.
 *
 * Использует Glicko-1 continuous через переиспользуемый
 * `GlickoRatingService.updateUserRatingContinuous` (apps/api/src/puzzle).
 *
 * Skip-логика (ADR §3.6.2):
 *   1. Гость (userId === null) → skip, ratingBefore/After = null.
 *   2. `User.isHidden || User.isTestAccount` → skip (service-аккаунты,
 *      ADR-035 §10.7-4).
 *   3. `puzzle.createdBy === userId` → skip (anti-cheat: нельзя качать
 *      рейтинг через свои же generated-задачи; ADR-079 §3.6.2, KS-3339
 *      ревизия 3).
 *
 * Маппинг `PrecisionAttempt.score` (0..100, ADR-065 5-звёздочный) в
 * Glicko-outcome (KS-3372: бинарная схема по решению пользователя —
 * только 5★ считаются «решено», всё остальное — «не решено», ничьих
 * нет):
 *   - score ≥ 95 (5★) → 1.0 (решено)
 *   - score < 95 (1–4★) → 0.0 (не решено)
 *
 * Соперник = `Puzzle.rating ?? 1500` (calibration fallback,
 * ADR §3.6.5). PuzzleRD = 50 (тот же фиксированный, что у drill).
 */
import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import type { PrismaClient } from '@kingside/db';
import { PrismaService } from '../prisma/prisma.service';
import { GlickoRatingService } from '../puzzle/glicko-rating.service';

export const PRECISION_RATING_DEFAULT = {
  rating: 1500,
  deviation: 350,
  volatility: 0.06,
} as const;

/** Фиксированный RD пазла (как в drill: см. TacticDrillRatingService). */
const PUZZLE_RD = 50;

export type PrecisionRatingTx = Pick<
  PrismaClient,
  | 'userPrecisionRating'
  | 'user'
  | 'puzzle'
>;

export interface ApplyRatingChangeResult {
  /**
   * `ratingBefore`/`ratingAfter` — для записи в `PrecisionAttempt`.
   * `null` если skipped (гость / hidden-test / self-created).
   */
  ratingBefore: number | null;
  ratingAfter: number | null;
  /** Skip-reason для логирования / диагностики (не для UI). */
  skipped?: 'guest' | 'hidden-or-test' | 'self-created' | 'no-puzzle';
}

@Injectable()
export class PrecisionRatingService {
  private readonly logger = new Logger(PrecisionRatingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => GlickoRatingService))
    private readonly glicko: GlickoRatingService,
  ) {}

  /**
   * Маппинг `PrecisionAttempt.score` (0..100) → Glicko-outcome (0 или 1).
   *
   * KS-3372 (по решению пользователя): бинарная схема, **без ничьих**.
   * Только 5★ (score ≥ 95 по ADR-065 §4) считается «решено». Любая
   * другая оценка (1–4★) — «не решено». Старая разнесённая шкала
   * (≥80 → 1.0; ≥50 → 0.5; иначе 0) приводила к парадоксу: 81%
   * точности при 3★ давала «победу» в Glicko и +24 к рейтингу, хотя
   * UI показывал «решено с заметными ошибками» — пороги outcome не
   * совпадали с границами звёзд.
   *
   * См. ADR-079 §3.6.2 (обновлённый).
   */
  scoreToOutcome(score: number | null | undefined): number {
    if (score == null) return 0;
    return score >= 95 ? 1 : 0;
  }

  /**
   * Применяет обновление рейтинга. Идемпотентно по своему вызову —
   * caller должен сам решать, вызывать ли (например, один раз на
   * `tx.precisionAttempt.create`).
   *
   * Возвращает `{ ratingBefore, ratingAfter }` для записи в attempt.
   * `null/null + skipped` — если по правилам ADR обновление пропущено.
   *
   * Внутри использует переданную транзакционную обёртку (`tx`), либо
   * `this.prisma` если null. Это позволяет вызывающему service'у
   * сохранить атомарность с `tx.precisionAttempt.create`.
   */
  async applyRatingChange(
    userId: string | null,
    puzzleId: string,
    score: number | null,
    tx?: PrecisionRatingTx,
  ): Promise<ApplyRatingChangeResult> {
    const db: PrecisionRatingTx = tx ?? (this.prisma as unknown as PrecisionRatingTx);

    // 1. Skip guests.
    if (!userId) {
      return { ratingBefore: null, ratingAfter: null, skipped: 'guest' };
    }

    // 2. Skip hidden/test-аккаунты.
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { isHidden: true, isTestAccount: true },
    });
    if (!user || user.isHidden || user.isTestAccount) {
      return {
        ratingBefore: null,
        ratingAfter: null,
        skipped: 'hidden-or-test',
      };
    }

    // 3. Skip self-created (anti-cheat KS-3339 ревизия 3).
    const puzzle = await db.puzzle.findUnique({
      where: { id: puzzleId },
      select: { rating: true, createdBy: true },
    });
    if (!puzzle) {
      return { ratingBefore: null, ratingAfter: null, skipped: 'no-puzzle' };
    }
    if (puzzle.createdBy === userId) {
      return {
        ratingBefore: null,
        ratingAfter: null,
        skipped: 'self-created',
      };
    }

    // 4. Получаем (или создаём) UserPrecisionRating.
    const current = await db.userPrecisionRating.findUnique({
      where: { userId },
    });
    const ratingBefore = current?.rating ?? PRECISION_RATING_DEFAULT.rating;
    const deviation = current?.deviation ?? PRECISION_RATING_DEFAULT.deviation;
    const attempts = current?.attempts ?? 0;

    // 5. Маппинг score → outcome.
    const outcome = this.scoreToOutcome(score);

    // 6. Соперник = Puzzle.rating (или 1500 для неоткалиброванных).
    const opponentRating = puzzle.rating ?? PRECISION_RATING_DEFAULT.rating;

    // 7. Glicko-1 continuous update.
    const { newRating, newRD } = this.glicko.updateUserRatingContinuous(
      ratingBefore,
      deviation,
      opponentRating,
      PUZZLE_RD,
      outcome,
    );

    // 8. Upsert.
    const now = new Date();
    await db.userPrecisionRating.upsert({
      where: { userId },
      create: {
        userId,
        rating: newRating,
        deviation: newRD,
        volatility: PRECISION_RATING_DEFAULT.volatility,
        attempts: 1,
        lastAttemptAt: now,
      },
      update: {
        rating: newRating,
        deviation: newRD,
        attempts: attempts + 1,
        lastAttemptAt: now,
      },
    });

    this.logger.log(
      `[precision-rating] user=${userId.slice(0, 8)} puzzle=${puzzleId.slice(0, 8)} ` +
        `score=${score} outcome=${outcome} ` +
        `rating ${ratingBefore}→${newRating} (Δ${newRating - ratingBefore}) rd=${newRD}`,
    );

    return { ratingBefore, ratingAfter: newRating };
  }
}
