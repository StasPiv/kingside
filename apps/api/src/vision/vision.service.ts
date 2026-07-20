/**
 * KS-4982 / ADR-167 §5: сервис Vision-тренажёра (зрение доски).
 *
 * Принцип (ADR §5): генерация и подсчёт — на клиенте; сервер хранит итог
 * сессии (`vision_scores`) и отдаёт лидерборд/статистику/историю.
 * Пер-вопросного эндпоинта нет. Гость (не авторизован) не сохраняется.
 * Лидерборд «тренировочного» класса — анти-чит отложен (ADR §5.2).
 *
 * Лидерборд кэшируется в Redis через `CacheService.getOrSet` (TTL 60с),
 * как puzzle-rush/tactic-drill.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type {
  VisionHistoryResponse,
  VisionLeaderboardEntry,
  VisionLeaderboardResponse,
  VisionMode,
  VisionResult,
  VisionStatsResponse,
  VisionSubmitResultResponse,
  VisionTimeMode,
} from '@kingside/shared';
import { VISION_MODES, VISION_TIME_MODES } from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/cache.service';

@Injectable()
export class VisionService {
  private readonly logger = new Logger(VisionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  // ─── POST /vision/results ──────────────────────────────────────────

  /**
   * Сохраняет итог сессии авторизованного пользователя. `total > 0` и
   * `score <= total` обязательны. `accuracy` пересчитывается на сервере
   * из score/total (клиентское значение игнорируется — единая формула).
   */
  async saveResult(
    userId: string,
    body: VisionResult,
  ): Promise<VisionSubmitResultResponse> {
    if (body.total <= 0) {
      throw new BadRequestException('total must be > 0');
    }
    if (body.score > body.total) {
      throw new BadRequestException('score cannot exceed total');
    }
    if (body.maxStreak > body.total) {
      throw new BadRequestException('maxStreak cannot exceed total');
    }
    const accuracy = Math.round((body.score / body.total) * 10000) / 10000;

    const row = await this.prisma.visionScore.create({
      data: {
        userId,
        mode: body.mode,
        timeMode: body.timeMode,
        difficulty: body.difficulty,
        score: body.score,
        total: body.total,
        accuracy,
        maxStreak: body.maxStreak,
        avgResponseMs: body.avgResponseMs,
      },
      select: { id: true },
    });

    // Инвалидация кэша лидерборда этого (mode,timeMode).
    await this.cache.invalidate(
      `cache:vision:leaderboard:${body.mode}:${body.timeMode}:*`,
    );

    this.logger.log(
      `[vision] result saved user=${userId.slice(0, 8)} mode=${body.mode} ` +
        `timeMode=${body.timeMode} score=${body.score}/${body.total} ` +
        `acc=${accuracy} id=${row.id}`,
    );
    return { saved: true, scoreId: row.id };
  }

  // ─── GET /vision/leaderboard ───────────────────────────────────────

  async leaderboard(
    mode: string,
    timeMode: string,
    limit = 20,
  ): Promise<VisionLeaderboardResponse> {
    const m = this.assertMode(mode);
    const tm = this.assertTimeMode(timeMode);
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const cacheKey = `cache:vision:leaderboard:${m}:${tm}:${safeLimit}`;
    return this.cache.getOrSet(cacheKey, 60, () =>
      this.fetchLeaderboard(m, tm, safeLimit),
    );
  }

  private async fetchLeaderboard(
    mode: VisionMode,
    timeMode: VisionTimeMode,
    limit: number,
  ): Promise<VisionLeaderboardResponse> {
    // Лучший результат каждого пользователя для (mode,timeMode) через
    // DISTINCT ON, затем сортировка по score desc. Скрытые аккаунты —
    // вне публичного лидерборда (как puzzle-rush, ADR-036 §3.4).
    const rows = await this.prisma.$queryRaw<
      Array<{
        userId: string;
        username: string | null;
        score: number;
        accuracy: number;
        createdAt: Date;
      }>
    >`
      SELECT sub.user_id AS "userId", sub.username, sub.score,
             sub.accuracy, sub.created_at AS "createdAt"
      FROM (
        SELECT DISTINCT ON (vs.user_id)
          vs.user_id, u.username, vs.score, vs.accuracy, vs.created_at
        FROM vision_scores vs
        JOIN users u ON u.id = vs.user_id
        WHERE vs.mode = ${mode}
          AND vs.time_mode = ${timeMode}
          AND u.is_hidden = FALSE
        ORDER BY vs.user_id, vs.score DESC, vs.created_at ASC
      ) sub
      ORDER BY sub.score DESC, sub."createdAt" ASC
      LIMIT ${limit}
    `;

    const entries: VisionLeaderboardEntry[] = rows.map((r) => ({
      userId: r.userId,
      username: r.username ?? 'Anonymous',
      mode,
      timeMode,
      score: r.score,
      accuracy: r.accuracy,
      createdAt: r.createdAt.toISOString(),
    }));
    return { mode, timeMode, entries };
  }

  // ─── GET /vision/stats/me ──────────────────────────────────────────

  async statsForUser(userId: string): Promise<VisionStatsResponse> {
    const [agg, byModeRows] = await Promise.all([
      this.prisma.visionScore.aggregate({
        where: { userId },
        _count: { _all: true },
        _max: { score: true, maxStreak: true },
        _avg: { accuracy: true, avgResponseMs: true },
      }),
      this.prisma.visionScore.groupBy({
        by: ['mode'],
        where: { userId },
        _count: { _all: true },
        _max: { score: true },
      }),
    ]);

    const byMode = byModeRows
      .map((r) => ({
        mode: r.mode as VisionMode,
        sessions: r._count._all,
        bestScore: r._max.score ?? 0,
      }))
      .sort((a, b) => b.sessions - a.sessions);

    return {
      totalSessions: agg._count._all,
      bestScore: agg._max.score ?? 0,
      avgAccuracy: agg._avg.accuracy
        ? Math.round(agg._avg.accuracy * 10000) / 10000
        : 0,
      bestMaxStreak: agg._max.maxStreak ?? 0,
      avgResponseMs: agg._avg.avgResponseMs
        ? Math.round(agg._avg.avgResponseMs)
        : 0,
      byMode,
    };
  }

  // ─── GET /vision/history ───────────────────────────────────────────

  async historyForUser(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<VisionHistoryResponse> {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    type Cursor = { t: string; g: string };
    let decoded: Cursor | null = null;
    if (cursor) {
      try {
        const text = Buffer.from(cursor, 'base64').toString('utf8');
        const obj = JSON.parse(text) as Partial<Cursor>;
        if (typeof obj.t === 'string' && typeof obj.g === 'string') {
          decoded = { t: obj.t, g: obj.g };
        }
      } catch {
        // Невалидный cursor → первая страница.
      }
    }

    const rows = await this.prisma.visionScore.findMany({
      where: {
        userId,
        ...(decoded
          ? {
              OR: [
                { createdAt: { lt: new Date(decoded.t) } },
                { createdAt: new Date(decoded.t), id: { lt: decoded.g } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: safeLimit + 1,
    });

    const hasMore = rows.length > safeLimit;
    const items = (hasMore ? rows.slice(0, safeLimit) : rows).map((r) => ({
      id: r.id,
      mode: r.mode as VisionMode,
      timeMode: r.timeMode as VisionTimeMode,
      difficulty: r.difficulty,
      score: r.score,
      total: r.total,
      accuracy: r.accuracy,
      maxStreak: r.maxStreak,
      avgResponseMs: r.avgResponseMs,
      createdAt: r.createdAt.toISOString(),
    }));
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ t: last.createdAt, g: last.id }),
          ).toString('base64')
        : null;
    return { items, nextCursor, hasMore };
  }

  // ─── helpers ───────────────────────────────────────────────────────

  private assertMode(mode: string): VisionMode {
    if (!(VISION_MODES as readonly string[]).includes(mode)) {
      throw new BadRequestException(`invalid mode '${mode}'`);
    }
    return mode as VisionMode;
  }

  private assertTimeMode(timeMode: string): VisionTimeMode {
    if (!(VISION_TIME_MODES as readonly string[]).includes(timeMode)) {
      throw new BadRequestException(`invalid timeMode '${timeMode}'`);
    }
    return timeMode as VisionTimeMode;
  }
}
