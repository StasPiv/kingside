/**
 * KS-2311 (methodology §10, Drills E6). Drill rating (Glicko-1 для
 * users, фиксированный rating per drill).
 *
 * Контракт `applyRatingChange(userId, drill, attempt)` (методика §10.11):
 *  1. Skip если sprint mode (§10.6) — sprint имеет собственный
 *     leaderboard, drill-rating не должен качаться через лёгкие
 *     задачи в sprint pool.
 *  2. Skip если `User.isHidden` или `isTestAccount` — service-аккаунты
 *     не светятся в leaderboard'е (§10.7-4 + KS-2256).
 *  3. Outcome (§10.5): IoU для shape='squares', binary иначе.
 *  4. Glicko-1 continuous update.
 *  5. Burst penalty (§10.7-3): >30 attempts/час одного drill-type →
 *     gain × 0.33. Redis counter с TTL 1 час.
 *  6. Daily cap +50 в drill mode (§10.7-2). Положительные дельты
 *     обрезаются; отрицательные не cap'аются.
 *  7. Запись `ratingBefore/ratingAfter/ratingCapped` в attempt.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GlickoRatingService } from '../puzzle/glicko-rating.service';
import type { AnswerData, TacticDrillType } from '@kingside/shared';
import type { ValidationMetrics } from './tactic-drill-validator.service';

export const BUCKET_TO_RATING: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 1000,
  2: 1300,
  3: 1500,
  4: 1700,
  5: 2000,
};
export const DRILL_RD = 50;
export const DAILY_CAP_DRILL = 50;
export const BURST_LIMIT = 30; // attempts/hour per drill-type
export const BURST_PENALTY = 0.33;
export const LEADERBOARD_MIN_ATTEMPTS = 20;

export interface DrillAttemptInput {
  drillId: string;
  attemptId: string; // id записи в `tactic_drill_attempts`
  mode: 'drill' | 'sprint' | 'lessons-embed';
  solved: boolean;
  metrics?: ValidationMetrics;
  userAnswer: AnswerData;
}

export interface RatingChangeResult {
  before: number;
  after: number;
  capped: boolean;
  rdBefore: number;
  rdAfter: number;
}

@Injectable()
export class TacticDrillRatingService {
  private readonly logger = new Logger(TacticDrillRatingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly glicko: GlickoRatingService,
  ) {}

  /**
   * Применяет drill-rating-update по результатам попытки. Возвращает
   * `null` если update пропущен (гость / sprint / hidden / etc.) —
   * caller получает это для понимания «нужно ли обновлять
   * tactic_drill_attempts.ratingBefore/After».
   */
  async applyRatingChange(
    userId: string | null,
    input: DrillAttemptInput,
  ): Promise<RatingChangeResult | null> {
    // §10.6: только drill mode влияет на rating.
    if (input.mode !== 'drill') return null;
    // Гости не имеют user-rating'а.
    if (!userId) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        ratingDrill: true,
        ratingDrillDev: true,
        isHidden: true,
        isTestAccount: true,
      },
    });
    if (!user) return null;

    // §10.7-4: hidden / test юзеры — rating не обновляется.
    if (user.isHidden || user.isTestAccount) return null;

    const drill = await this.prisma.tacticDrill.findUnique({
      where: { id: input.drillId },
      select: { type: true, difficulty: true, rating: true },
    });
    if (!drill) return null;

    const drillRating = drill.rating ?? this.bucketRating(drill.difficulty);
    const score = this.computeScore(input);

    // §10.7-3: burst-detection.
    const burstKey = this.burstKey(userId, drill.type as TacticDrillType);
    const burstCount = await this.redis.incr(burstKey);
    if (burstCount === 1) {
      await this.redis.expire(burstKey, 3600);
    }
    const burstPenaltyMul = burstCount > BURST_LIMIT ? BURST_PENALTY : 1.0;

    // Glicko-1 continuous update.
    const update = this.glicko.updateUserRatingContinuous(
      user.ratingDrill,
      user.ratingDrillDev,
      drillRating,
      DRILL_RD,
      score,
    );

    let proposedDelta = update.newRating - user.ratingDrill;
    if (proposedDelta !== 0 && burstPenaltyMul !== 1.0) {
      proposedDelta = Math.round(proposedDelta * burstPenaltyMul);
    }

    // §10.7-2: daily cap (positive only).
    let capped = false;
    if (proposedDelta > 0) {
      const dailyChange = await this.getUserDailyRatingChange(userId);
      const remainingCap = DAILY_CAP_DRILL - dailyChange;
      if (remainingCap <= 0) {
        proposedDelta = 0;
        capped = true;
      } else if (proposedDelta > remainingCap) {
        proposedDelta = remainingCap;
        capped = true;
      }
    }

    const finalRating = user.ratingDrill + proposedDelta;
    const finalRD = update.newRD;

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ratingDrill: finalRating,
        ratingDrillDev: finalRD,
      },
    });

    // Update attempt с rating-snapshot (если есть attemptId).
    if (input.attemptId) {
      await this.prisma.tacticDrillAttempt
        .update({
          where: { id: input.attemptId },
          data: {
            ratingBefore: user.ratingDrill,
            ratingAfter: finalRating,
            ratingCapped: capped,
          },
        })
        .catch((err) => {
          // Если attempt-id некорректный (теоретически невозможно
          // сразу после create) — лог и идём дальше; rating уже
          // обновлён, attempt-snapshot не критичен для leaderboard'а.
          this.logger.warn(
            `failed to write rating-snapshot for attempt=${input.attemptId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }

    return {
      before: user.ratingDrill,
      after: finalRating,
      capped,
      rdBefore: user.ratingDrillDev,
      rdAfter: finalRD,
    };
  }

  /**
   * Сумма позитивных delta (`ratingAfter - ratingBefore`) за последние
   * 24 часа для daily cap. Учитывает только drill-mode записи (sprint
   * не пишет rating-snapshot, см. §10.6).
   */
  async getUserDailyRatingChange(userId: string): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.prisma.tacticDrillAttempt.findMany({
      where: {
        userId,
        createdAt: { gte: since },
        ratingBefore: { not: null },
        ratingAfter: { not: null },
      },
      select: { ratingBefore: true, ratingAfter: true },
    });
    let total = 0;
    for (const r of rows) {
      if (r.ratingBefore == null || r.ratingAfter == null) continue;
      const delta = r.ratingAfter - r.ratingBefore;
      if (delta > 0) total += delta;
    }
    return total;
  }

  /**
   * Leaderboard: топ по `ratingDrill`, фильтр `attempts >= 20`,
   * исключаем `isHidden`. Возвращает порядковый rank.
   */
  async leaderboard(limit: number): Promise<{
    entries: {
      userId: string;
      username: string | null;
      ratingDrill: number;
      ratingDrillDev: number;
      attempts: number;
      rank: number;
    }[];
  }> {
    const safeLimit = Math.max(1, Math.min(limit, 500));
    // Один SQL — топ юзеров с attempts ≥ 20, без isHidden, отсортирован
    // по rating_drill DESC. Используем groupBy + filter.
    const rows = await this.prisma.$queryRaw<
      {
        userId: string;
        username: string | null;
        ratingDrill: number;
        ratingDrillDev: number;
        attempts: number;
      }[]
    >`
      SELECT u.id          AS "userId",
             u.username    AS "username",
             u.rating_drill     AS "ratingDrill",
             u.rating_drill_dev AS "ratingDrillDev",
             COUNT(a.id)::int   AS "attempts"
        FROM users u
        LEFT JOIN tactic_drill_attempts a ON a.user_id = u.id
       WHERE u.is_hidden = FALSE
         AND u.is_test_account = FALSE
       GROUP BY u.id
       HAVING COUNT(a.id) >= ${LEADERBOARD_MIN_ATTEMPTS}
       ORDER BY u.rating_drill DESC, u.id ASC
       LIMIT ${safeLimit}
    `;

    return {
      entries: rows.map((r, i) => ({
        userId: r.userId,
        username: r.username,
        ratingDrill: r.ratingDrill,
        ratingDrillDev: r.ratingDrillDev,
        attempts: r.attempts,
        rank: i + 1,
      })),
    };
  }

  // ─── helpers ─────────────────────────────────────────────

  private computeScore(input: DrillAttemptInput): number {
    if (input.userAnswer.shape === 'squares') {
      // §10.5: для squares используем IoU как continuous score.
      // Если metrics нет (теоретически не должно быть для squares,
      // но защищаемся) — fallback на binary solved.
      return input.metrics?.iou ?? (input.solved ? 1 : 0);
    }
    return input.solved ? 1 : 0;
  }

  private bucketRating(difficulty: number): number {
    return (
      BUCKET_TO_RATING[difficulty as 1 | 2 | 3 | 4 | 5] ?? 1500
    );
  }

  private burstKey(userId: string, drillType: TacticDrillType): string {
    const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
    return `tactic-drill:burst:${userId}:${drillType}:${hourBucket}`;
  }
}
