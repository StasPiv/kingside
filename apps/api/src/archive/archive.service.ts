import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import type {
  ArchiveBucket,
  ArchiveGameDetail,
  ArchiveGameResult,
  ArchiveGameSummary,
  ArchiveGamesRequest,
  ArchiveGamesResponse,
  ArchiveTreeRequest,
  ArchiveTreeResponse,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  ARCHIVE_STATS_REPOSITORY,
  ArchiveStatsRepository,
  TreeOpts,
} from './archive-stats.repository';
import { ArchiveMetricsService } from './archive-metrics.service';
import { positionKey, positionKeyHex } from './position-key';

const DEFAULT_TREE_LIMIT = 12;
const DEFAULT_GAMES_LIMIT = 50;
const MAX_GAMES_LIMIT = 200;
const TREE_CACHE_TTL_SEC = 3600;
export const ARCHIVE_IMPORTED_CHANNEL = 'archive:imported';

/**
 * Orchestrates archive REST queries: Redis-cached variation tree,
 * filtered game listing, and single game detail. Subscribes to the
 * `archive:imported` PUB/SUB channel and invalidates cached trees after
 * a successful import.
 */
@Injectable()
export class ArchiveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ArchiveService.name);
  private subRedis: Redis | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: ArchiveMetricsService,
    @Inject(ARCHIVE_STATS_REPOSITORY)
    private readonly stats: ArchiveStatsRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    // Separate connection — ioredis enters subscriber mode per-connection.
    this.subRedis = this.redis.duplicate();

    try {
      await this.subRedis.subscribe(ARCHIVE_IMPORTED_CHANNEL);
      this.subRedis.on('message', (channel, _message) => {
        if (channel === ARCHIVE_IMPORTED_CHANNEL) {
          void this.invalidateTreeCache();
        }
      });
      this.logger.log(
        `Subscribed to "${ARCHIVE_IMPORTED_CHANNEL}" for cache invalidation`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to subscribe to ${ARCHIVE_IMPORTED_CHANNEL}: ${(err as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subRedis) {
      await this.subRedis.unsubscribe().catch(() => {});
      await this.subRedis.quit().catch(() => {});
      this.subRedis = null;
    }
  }

  // ─── Tree ────────────────────────────────────────────────────────

  async getTree(req: ArchiveTreeRequest): Promise<ArchiveTreeResponse> {
    const bucket: ArchiveBucket = req.bucket ?? 'master';
    const limit = this.clampLimit(req.limit, DEFAULT_TREE_LIMIT, DEFAULT_TREE_LIMIT);
    const since = req.since ? new Date(req.since) : undefined;

    const key = positionKey(req.fen);
    const keyHex = positionKeyHex(key);
    const filtersHash = this.hashFilters({
      minElo: req.minElo,
      since: req.since,
      limit,
    });
    const cacheKey = `arch:tree:${keyHex}:${bucket}:${filtersHash}`;

    const startNs = process.hrtime.bigint();

    const cached = await this.safeGetCached(cacheKey);
    if (cached) {
      this.metrics.recordTreeQuery(true, this.elapsedSec(startNs));
      return cached;
    }

    const opts: TreeOpts = {
      fen: req.fen,
      bucket,
      minElo: req.minElo,
      since,
      limit,
    };
    const response = await this.stats.getTree(key, opts);

    await this.safeSetCached(cacheKey, response);
    this.metrics.recordTreeQuery(false, this.elapsedSec(startNs));

    return response;
  }

  // ─── Games list ──────────────────────────────────────────────────

  async getGames(req: ArchiveGamesRequest): Promise<ArchiveGamesResponse> {
    const limit = this.clampLimit(req.limit, DEFAULT_GAMES_LIMIT, MAX_GAMES_LIMIT);
    const offset = req.offset && req.offset > 0 ? Math.floor(req.offset) : 0;

    const where: Record<string, unknown> = {};
    if (req.eco) where.eco = req.eco;
    if (req.result) where.result = req.result;
    if (req.since) {
      where.playedAt = { gte: new Date(req.since) };
    }
    if (req.white) where.whiteName = { contains: req.white, mode: 'insensitive' };
    if (req.black) where.blackName = { contains: req.black, mode: 'insensitive' };

    if (req.player) {
      where.OR = [
        { whiteName: { contains: req.player, mode: 'insensitive' } },
        { blackName: { contains: req.player, mode: 'insensitive' } },
      ];
    }

    // NOTE: fen/move filters require a position_stats join and are deferred
    // to a follow-up (KS-1581 MVP scope, see ADR §4.2). They are accepted
    // by the DTO but silently ignored at the service level for now.

    const [total, items] = await Promise.all([
      this.prisma.archiveGame.count({ where }),
      this.prisma.archiveGame.findMany({
        where,
        orderBy: [{ playedAt: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
        select: this.gameSummarySelect(),
      }),
    ]);

    return {
      total,
      items: items.map((g) => this.toSummary(g)),
    };
  }

  async getGameById(id: string): Promise<ArchiveGameDetail> {
    const game = await this.prisma.archiveGame.findUnique({ where: { id } });
    if (!game) {
      throw new NotFoundException(`Archive game ${id} not found`);
    }

    return {
      ...this.toSummary(game),
      pgn: game.pgn,
      site: game.site ?? null,
      round: game.round ?? null,
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private gameSummarySelect() {
    return {
      id: true,
      event: true,
      site: true,
      round: true,
      date: true,
      playedAt: true,
      whiteName: true,
      blackName: true,
      whiteElo: true,
      blackElo: true,
      whiteTitle: true,
      blackTitle: true,
      result: true,
      eco: true,
      opening: true,
      plyCount: true,
      pgn: true,
    };
  }

  private toSummary(
    g: {
      id: string;
      event: string | null;
      date: string | null;
      playedAt: Date | null;
      whiteName: string | null;
      blackName: string | null;
      whiteElo: number | null;
      blackElo: number | null;
      whiteTitle: string | null;
      blackTitle: string | null;
      result: string | null;
      eco: string | null;
      opening: string | null;
      plyCount: number | null;
    },
  ): ArchiveGameSummary {
    return {
      id: g.id,
      white: { name: g.whiteName, elo: g.whiteElo, title: g.whiteTitle },
      black: { name: g.blackName, elo: g.blackElo, title: g.blackTitle },
      result: (g.result ?? null) as ArchiveGameResult | null,
      eco: g.eco,
      opening: g.opening,
      event: g.event,
      date: g.playedAt ? g.playedAt.toISOString() : g.date ?? null,
      plyCount: g.plyCount,
    };
  }

  private clampLimit(raw: number | undefined, fallback: number, max: number): number {
    if (raw === undefined || raw === null) return fallback;
    const n = Math.floor(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
  }

  private hashFilters(filters: { minElo?: number; since?: string; limit: number }): string {
    const canon = JSON.stringify({
      minElo: filters.minElo ?? null,
      since: filters.since ?? null,
      limit: filters.limit,
    });
    return createHash('sha1').update(canon).digest('hex').slice(0, 12);
  }

  private async safeGetCached(key: string): Promise<ArchiveTreeResponse | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as ArchiveTreeResponse) : null;
    } catch (err) {
      this.logger.warn(`cache read failed (${key}): ${(err as Error).message}`);
      return null;
    }
  }

  private async safeSetCached(key: string, value: ArchiveTreeResponse): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', TREE_CACHE_TTL_SEC);
    } catch (err) {
      this.logger.warn(`cache write failed (${key}): ${(err as Error).message}`);
    }
  }

  private async invalidateTreeCache(): Promise<void> {
    try {
      const keys = await this.redis.keys('arch:tree:*');
      if (keys.length > 0) {
        await this.redis.del(...keys);
        this.logger.log(
          `Invalidated ${keys.length} archive tree cache entries after import`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `tree cache invalidation failed: ${(err as Error).message}`,
      );
    }
  }

  private elapsedSec(startNs: bigint): number {
    const deltaNs = process.hrtime.bigint() - startNs;
    return Number(deltaNs) / 1e9;
  }
}
