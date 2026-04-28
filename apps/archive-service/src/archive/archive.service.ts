import {
  BadRequestException,
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
  ArchiveGamesByPositionRequest,
  ArchiveGamesByPositionResponse,
  ArchiveGamesRequest,
  ArchiveGamesResponse,
  ArchiveGamesSort,
  ArchiveGamesSortMetadata,
  ArchiveTreeRequest,
  ArchiveTreeResponse,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  ARCHIVE_STATS_REPOSITORY,
  ArchiveStatsRepository,
  GamesByPositionOpts,
  RawArchiveGameRow,
  RawGamePositionRow,
  SearchGamesOpts,
  TreeOpts,
} from './archive-stats.repository';
import { ArchiveMetricsService } from './archive-metrics.service';
import { positionKey, positionKeyHex } from './position-key';
import { resultFilterToStorage } from './result-format';
import {
  ArchiveCursor,
  decodeCursor,
  encodeCursor,
  isRecentCursor,
  isTopEloCursor,
} from './cursor-codec';
import { STATIC_PREWARM_POSITIONS } from './prewarm-positions';

const DEFAULT_TREE_LIMIT = 12;
const DEFAULT_GAMES_LIMIT = 50;
const MAX_GAMES_LIMIT = 200;
const DEFAULT_GAMES_BY_POSITION_LIMIT = 20;
const MAX_GAMES_BY_POSITION_LIMIT = 50;
/**
 * Жёсткий потолок offset-пагинации в metadata-листе (KS-2063).
 * Глубокий offset на больших корпусах (~10⁵+ партий) приводит к full
 * sequential scan'у — UX (бесконечный скролл) при таких offset бесполезен.
 * Клиенты должны переключаться на сортировку/фильтры или keyset (по
 * by-position эндпоинту).
 */
const MAX_GAMES_OFFSET = 5000;
const TREE_CACHE_TTL_SEC = 3600;
const GAMES_BY_POSITION_CACHE_TTL_SEC = 600; // 10 min, ADR-014 §7
const PREWARM_INTERVAL_MS = 15 * 60 * 1000; // 15 min, ADR-014 §7
const PREWARM_TOP_N = 30;
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
  private prewarmTimer: NodeJS.Timeout | null = null;

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
          void this.invalidateArchiveCache();
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

    // Pre-warm cron (ADR-014 §7). Runs every 15 min; first tick scheduled
    // to not block startup. Tests opt out via ARCHIVE_PREWARM_DISABLE=1.
    if (process.env.ARCHIVE_PREWARM_DISABLE !== '1') {
      this.prewarmTimer = setInterval(() => {
        void this.prewarmTopPositions();
      }, PREWARM_INTERVAL_MS);
      // First run slightly after boot so DB pool is ready.
      setTimeout(() => void this.prewarmTopPositions(), 30_000).unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.prewarmTimer) {
      clearInterval(this.prewarmTimer);
      this.prewarmTimer = null;
    }
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
    const offsetRaw = req.offset && req.offset > 0 ? Math.floor(req.offset) : 0;

    if (offsetRaw > MAX_GAMES_OFFSET) {
      throw new BadRequestException(
        `offset must be <= ${MAX_GAMES_OFFSET} (got ${offsetRaw}); use filters or by-position keyset for deeper navigation`,
      );
    }

    if (
      req.minPly != null &&
      req.maxPly != null &&
      req.minPly > req.maxPly
    ) {
      throw new BadRequestException('minPly must be <= maxPly');
    }

    const sort: ArchiveGamesSortMetadata = req.sort ?? 'recent';

    // NOTE: fen/move filters require a position_stats join and are deferred
    // to a follow-up (KS-1581 MVP scope, see ADR §4.2). They are accepted
    // by the DTO but silently ignored at the service level for now.

    const opts: SearchGamesOpts = {
      white: req.white,
      black: req.black,
      player: req.player,
      eco: req.eco,
      event: req.event,
      result: req.result,
      minElo: req.minElo,
      minPly: req.minPly,
      maxPly: req.maxPly,
      since: req.since ? new Date(req.since) : undefined,
      until: req.until ? new Date(req.until) : undefined,
      sort,
      limit,
      offset: offsetRaw,
    };

    const page = await this.stats.searchGames(opts);

    return {
      total: page.total,
      items: page.items.map((g) => this.rawRowToSummary(g)),
    };
  }

  // ─── Games by position ───────────────────────────────────────────

  async getGamesByPosition(
    req: ArchiveGamesByPositionRequest,
  ): Promise<ArchiveGamesByPositionResponse> {
    const bucket: ArchiveBucket = req.bucket ?? 'master';
    const sort: ArchiveGamesSort = req.sort ?? 'recent';
    const limit = this.clampLimit(
      req.limit,
      DEFAULT_GAMES_BY_POSITION_LIMIT,
      MAX_GAMES_BY_POSITION_LIMIT,
    );

    const cursor = decodeCursor(req.cursor ?? null);
    // Cursor shape must match the requested sort — otherwise ignore it.
    const validCursor =
      cursor == null ||
      (sort === 'recent' ? isRecentCursor(cursor) : isTopEloCursor(cursor))
        ? cursor
        : null;

    const key = positionKey(req.fen);
    const keyHex = positionKeyHex(key);

    const filterHash = this.hashGamesByPositionFilters(req, limit);
    const cacheKey = `arch:games:${keyHex}:${bucket}:${sort}:${filterHash}:${req.cursor ?? ''}`;

    const startNs = process.hrtime.bigint();
    const cached = await this.safeGetGamesCached(cacheKey);
    if (cached) {
      this.metrics.recordTreeQuery(true, this.elapsedSec(startNs));
      // Echo back the fen the caller passed — cached value may have been
      // populated by a different fen that normalizes to the same key.
      return { ...cached, fen: req.fen };
    }

    const sideToMove = this.deriveSideToMove(req);

    const opts: GamesByPositionOpts = {
      bucket,
      sort,
      cursor: validCursor ?? null,
      limit,
      minElo: req.minElo,
      since: req.since ? new Date(req.since) : undefined,
      result: resultFilterToStorage(req.result),
      sideToMove,
      move: req.move,
      player: req.player,
      eco: req.eco,
    };

    const [page, totalApproxRaw] = await Promise.all([
      this.stats.getGamesByPosition(key, opts),
      this.stats.countApprox(key, bucket),
    ]);

    const hasMore = page.overflow !== null;
    const nextCursor = hasMore
      ? encodeCursor(buildCursor(sort, page.overflow as RawGamePositionRow))
      : null;

    // Fail-closed guard (ADR-016 §Инвариант #3 "honest badge"): если
    // `position_stats` говорит о ≥1 партии на этой позиции, а
    // `archive_game_positions` не отдаёт ни одной (ни на этой странице, ни
    // overflow'ом в следующую) — бейдж "≈N партий" обманывает пользователя.
    // Скрываем число, чтобы UI показал fallback. До завершения ply-sync
    // backfill такие несоответствия ожидаемы; метрика помогает отследить
    // остаточный шум после прогрева.
    let totalApprox: number | null = totalApproxRaw;
    if (page.items.length === 0 && totalApproxRaw > 0) {
      this.metrics.recordListMismatch(bucket);
      this.logger.warn(
        `archive.list.mismatch positionKey=${keyHex} bucket=${bucket} ` +
          `totalApprox=${totalApproxRaw} filters=${this.hashGamesByPositionFilters(req, limit)}`,
      );
      totalApprox = null;
    }

    const response: ArchiveGamesByPositionResponse = {
      fen: req.fen,
      positionKey: keyHex,
      bucket,
      sort,
      items: page.items,
      nextCursor,
      hasMore,
      totalApprox,
    };

    await this.safeSetGamesCached(cacheKey, response);
    this.metrics.recordTreeQuery(false, this.elapsedSec(startNs));

    return response;
  }

  /** Internal: used by pre-warm with a FEN already known to be canonical. */
  private async prewarmOne(
    fen: string,
    bucket: ArchiveBucket,
    sort: ArchiveGamesSort,
  ): Promise<void> {
    await this.getGamesByPosition({
      fen,
      bucket,
      sort,
      limit: DEFAULT_GAMES_BY_POSITION_LIMIT,
    });
  }

  /**
   * Warms Redis for the static top-N opening positions (ADR-014 §7).
   *
   * MVP uses a hand-picked list in `prewarm-positions.ts`. A dynamic
   * top-N query over `position_stats` is possible (see
   * {@link ArchiveStatsRepository.listTopPositions}) but requires a
   * reverse lookup from `position_key` → FEN, which we don't store
   * today. Tracked as a follow-up.
   */
  async prewarmTopPositions(): Promise<void> {
    const positions = STATIC_PREWARM_POSITIONS.slice(0, PREWARM_TOP_N);
    let ok = 0;
    let failed = 0;
    for (const fen of positions) {
      for (const sort of ['recent', 'topElo'] as const) {
        try {
          await this.prewarmOne(fen, 'master', sort);
          ok++;
        } catch (err) {
          failed++;
          this.logger.warn(
            `prewarm failed for fen=${fen} sort=${sort}: ${(err as Error).message}`,
          );
        }
      }
    }
    if (ok > 0 || failed > 0) {
      this.logger.log(`prewarm: ok=${ok} failed=${failed}`);
    }
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

  /** Маппит raw-строку из `archive_games` в публичный {@link ArchiveGameSummary}. */
  private rawRowToSummary(r: RawArchiveGameRow): ArchiveGameSummary {
    return {
      id: r.id,
      white: {
        name: r.white_name,
        elo: r.white_elo == null ? null : Number(r.white_elo),
        title: r.white_title,
      },
      black: {
        name: r.black_name,
        elo: r.black_elo == null ? null : Number(r.black_elo),
        title: r.black_title,
      },
      result: (r.result ?? null) as ArchiveGameResult | null,
      eco: r.eco,
      opening: r.opening,
      event: r.event,
      date: r.played_at ? r.played_at.toISOString() : r.date ?? null,
      plyCount: r.ply_count == null ? null : Number(r.ply_count),
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

  private hashGamesByPositionFilters(
    req: ArchiveGamesByPositionRequest,
    limit: number,
  ): string {
    const canon = JSON.stringify({
      minElo: req.minElo ?? null,
      since: req.since ?? null,
      result: req.result ?? null,
      color: req.color ?? null,
      move: req.move ?? null,
      player: req.player ?? null,
      eco: req.eco ?? null,
      limit,
    });
    return createHash('sha1').update(canon).digest('hex').slice(0, 12);
  }

  /**
   * `color` resolution (MVP):
   *   - `white`/`black` → side_to_move filter on the position.
   *   - `any` / undefined → no filter (matches both sides).
   *
   * The intent of `color` interacts with `player` (e.g. "Carlsen as
   * white") — that combo is handled inside the repository via the
   * `player` filter, which spans both white/black names. Once the UI
   * requires strict "player-on-side", the player filter in the
   * repository must split into white-only / black-only paths.
   */
  private deriveSideToMove(
    req: ArchiveGamesByPositionRequest,
  ): 'w' | 'b' | undefined {
    if (!req.color || req.color === 'any') return undefined;
    return req.color === 'white' ? 'w' : 'b';
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

  /**
   * Invalidates both tree and games-by-position caches on import events.
   * Called in response to the `archive:imported` Redis pub/sub channel
   * (ADR-014 §7). A single SCAN would be faster, but `KEYS` is fine for
   * the MVP cache size and mirrors the existing tree-invalidation path.
   */
  private async invalidateArchiveCache(): Promise<void> {
    await Promise.all([
      this.invalidateTreeCache(),
      this.invalidateGamesByPositionCache(),
    ]);
  }

  private async invalidateGamesByPositionCache(): Promise<void> {
    try {
      const keys = await this.redis.keys('arch:games:*');
      if (keys.length > 0) {
        await this.redis.del(...keys);
        this.logger.log(
          `Invalidated ${keys.length} games-by-position cache entries after import`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `games-by-position cache invalidation failed: ${(err as Error).message}`,
      );
    }
  }

  private async safeGetGamesCached(
    key: string,
  ): Promise<ArchiveGamesByPositionResponse | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as ArchiveGamesByPositionResponse) : null;
    } catch (err) {
      this.logger.warn(`cache read failed (${key}): ${(err as Error).message}`);
      return null;
    }
  }

  private async safeSetGamesCached(
    key: string,
    value: ArchiveGamesByPositionResponse,
  ): Promise<void> {
    try {
      await this.redis.set(
        key,
        JSON.stringify(value),
        'EX',
        GAMES_BY_POSITION_CACHE_TTL_SEC,
      );
    } catch (err) {
      this.logger.warn(
        `cache write failed (${key}): ${(err as Error).message}`,
      );
    }
  }

  private elapsedSec(startNs: bigint): number {
    const deltaNs = process.hrtime.bigint() - startNs;
    return Number(deltaNs) / 1e9;
  }
}

/**
 * Builds a cursor from the N+1 overflow row used to mark `hasMore=true`.
 * Matches the ORDER BY clauses in `KeysetSqlBuilder`.
 */
function buildCursor(
  sort: ArchiveGamesSort,
  row: RawGamePositionRow,
): ArchiveCursor {
  if (sort === 'topElo') {
    return {
      e: row.avg_elo == null ? null : Number(row.avg_elo),
      g: row.game_id,
    };
  }
  return {
    t: row.played_at ? row.played_at.toISOString() : null,
    g: row.game_id,
  };
}
