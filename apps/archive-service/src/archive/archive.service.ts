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
  ArchiveEventSearchResponse,
  ArchiveGameDetail,
  ArchiveGameResult,
  ArchiveGameSummary,
  ArchiveGamesByPositionRequest,
  ArchiveGamesByPositionResponse,
  ArchiveGamesRequest,
  ArchiveGamesResponse,
  ArchiveGamesSort,
  ArchiveGamesSortMetadata,
  ArchivePlayerGameItem,
  ArchivePlayerGamesRequest,
  ArchivePlayerGamesResponse,
  ArchivePlayerProfileResponse,
  ArchivePlayerSearchResponse,
  ArchiveTimeControlCategory,
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
  RawPlayerGameRow,
  SearchGamesOpts,
  SearchPlayerGamesOpts,
  TreeOpts,
  resolveArchivePlayerSlug,
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
 * KS-2119. Лимит параллельных Prisma-запросов в prewarm. 2 — не сжирает
 * пул `connection_limit=20` (см. PrismaService) и оставляет ≥18 connection
 * для пользовательских `/tree`, `/games`, health-ping. Внутри одного
 * `prewarmOne` тоже могут идти ≤2 параллельных запроса
 * (`Promise.all([getGamesByPosition, countApprox])`), так что общий
 * worst-case prewarm-нагрузки на пул — ~4 connection.
 */
const PREWARM_PARALLELISM = 2;
/**
 * KS-2119. Пауза между prewarm-шагами — даёт пулу освободить connection
 * до следующего шага. Малое значение, но критическое: без него
 * sequential-loop возвращал connection и тут же снова брал, держа пул
 * занятым непрерывно.
 */
const PREWARM_STEP_DELAY_MS = 50;
/**
 * KS-2119. Отложенный старт фоновых prewarm после boot. 60s — даёт
 * health endpoint'у пройти readiness, ALB/CF подцепить таргет и
 * пользовательским запросам начать использовать пул раньше prewarm.
 */
const PREWARM_TOP_FIRST_DELAY_MS = 60_000;
const PREWARM_RECENT_FIRST_DELAY_MS = 10_000;
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
// KS-2065 / ADR-033 §4.4.7
const PLAYERS_SEARCH_CACHE_TTL_SEC = 300;       // 5 min
const PLAYERS_PROFILE_CACHE_TTL_SEC = 3600;     // 1 hour
const PLAYERS_GAMES_CACHE_TTL_SEC = 300;        // 5 min
const EVENTS_SEARCH_CACHE_TTL_SEC = 300;        // 5 min
// KS-2090: «Последние партии» на лобби `/archive`. TTL 60s — баланс между
// свежестью (TWIC импортируется ~раз в неделю, инвалидация по
// ARCHIVE_IMPORTED_CHANNEL мгновенная) и устранением cold-start'а.
const RECENT_GAMES_CACHE_TTL_SEC = 60;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_PLAYER_GAMES_LIMIT = 50;
const MAX_PLAYER_GAMES_LIMIT = 200;
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
    //
    // KS-2119: задержки увеличены (recent: 5→10s, top: 30→60s), чтобы
    // health endpoint успевал ответить readiness'ом ДО того, как prewarm
    // забирает первые connection из пула. Параллелизм prewarm ограничен
    // PREWARM_PARALLELISM (см. константу).
    if (process.env.ARCHIVE_PREWARM_DISABLE !== '1') {
      this.prewarmTimer = setInterval(() => {
        void this.prewarmTopPositions();
      }, PREWARM_INTERVAL_MS);
      setTimeout(
        () => void this.prewarmTopPositions(),
        PREWARM_TOP_FIRST_DELAY_MS,
      ).unref();
      // KS-2090: «Последние партии» лобби. Прогревает page cache индекса
      // archive_games_played_at_idx и сразу кладёт ответ в Redis с
      // TTL 60s — следующий пользователь, открывший /archive в первые
      // 60 секунд после старта, получит данные мгновенно.
      setTimeout(
        () => void this.prewarmRecentGames(),
        PREWARM_RECENT_FIRST_DELAY_MS,
      ).unref();
    }
  }

  /**
   * KS-2090: прогрев «Последних партий» (`/archive` лобби).
   *
   * Делает один dummy-вызов `getGames({sort:'recent', limit:DEFAULT})`,
   * который:
   *   1) выполняет `SELECT ... FROM archive_games ORDER BY played_at DESC
   *      LIMIT N` — ставит relevant pages индекса `played_at` и таблицы
   *      в page cache PostgreSQL (актуально для t3.micro RDS, KS-2090);
   *   2) кладёт ответ в Redis под ключ `arch:games:recent:<N>` с TTL 60s.
   *
   * Не блокирует startup; ошибки только логирует.
   */
  async prewarmRecentGames(): Promise<void> {
    try {
      await this.getGames({});
      this.logger.log('prewarmRecentGames: ok');
    } catch (err) {
      this.logger.warn(
        `prewarmRecentGames failed: ${(err as Error).message}`,
      );
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

    // KS-2090: «чистый recent» (sort=recent + offset=0 + нет фильтров) —
    // это тот самый блок «Последние партии» на `/archive`. Кэшируем в Redis
    // на 60s + не делаем COUNT(*) (фронту total не нужен — он показывает
    // ровно N последних партий). Инвалидация — по ARCHIVE_IMPORTED_CHANNEL
    // через `arch:games:*` паттерн (KS-2065).
    const isCleanRecent = sort === 'recent' && offsetRaw === 0 && this.hasNoFilters(req);
    if (isCleanRecent) {
      const cacheKey = `arch:games:recent:${limit}`;
      const cached = await this.safeGetJson<ArchiveGamesResponse>(cacheKey);
      if (cached) return cached;

      const page = await this.stats.searchGames({
        sort: 'recent',
        limit,
        offset: 0,
        skipTotal: true,
      });
      const response: ArchiveGamesResponse = {
        total: null,
        hasNext: page.hasNext,
        items: page.items.map((g) => this.rawRowToSummary(g)),
      };
      await this.safeSetJson(cacheKey, response, RECENT_GAMES_CACHE_TTL_SEC);
      return response;
    }

    // KS-2140: для всех запросов с фильтрами / non-recent sort / offset>0
    // COUNT(*) уходит в Parallel Seq Scan на 760 МБ heap (5-6 сек I/O на
    // db.t3.micro). Пропускаем COUNT — frontend (KS-2141) использует
    // `hasNext` от backend (LIMIT+1) вместо «N..M из total».
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
      timeControlCategory: normalizeTimeControlCategoryFilter(
        req.timeControlCategory,
      ),
      sort,
      limit,
      offset: offsetRaw,
      skipTotal: true,
    };

    const page = await this.stats.searchGames(opts);

    return {
      total: null,
      hasNext: page.hasNext,
      items: page.items.map((g) => this.rawRowToSummary(g)),
    };
  }

  /**
   * KS-2090: проверка «нет ни одного фильтра, влияющего на выборку».
   * Если все поля отсутствуют — `searchGames` сводится к
   * `SELECT ... ORDER BY played_at DESC LIMIT N` (с LEFT JOIN
   * archive_players за slug'ами). Это «recent-режим» лобби.
   */
  private hasNoFilters(req: ArchiveGamesRequest): boolean {
    if (req.fen || req.move) return false;
    if (req.white || req.black) return false;
    if (Array.isArray(req.player) ? req.player.length > 0 : !!req.player) return false;
    if (req.eco || req.event) return false;
    if (req.result) return false;
    if (req.minElo != null) return false;
    if (req.minPly != null || req.maxPly != null) return false;
    if (req.since || req.until) return false;
    // KS-2118: фильтр по контролю времени тоже отключает recent-кэш.
    if (
      Array.isArray(req.timeControlCategory)
        ? req.timeControlCategory.length > 0
        : !!req.timeControlCategory
    ) {
      return false;
    }
    return true;
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
   *
   * KS-2119. Параллелизм ограничен `PREWARM_PARALLELISM` (2). Между
   * шагами вставляем `PREWARM_STEP_DELAY_MS` — это гарантирует, что в
   * каждый момент времени prewarm удерживает не более ~4 connection
   * (2 × Promise.all внутри `getGamesByPosition`), оставляя пользовательским
   * запросам ≥16 connection из пула 20.
   */
  async prewarmTopPositions(): Promise<void> {
    const positions = STATIC_PREWARM_POSITIONS.slice(0, PREWARM_TOP_N);
    const tasks: Array<{ fen: string; sort: ArchiveGamesSort }> = [];
    for (const fen of positions) {
      for (const sort of ['recent', 'topElo'] as const) {
        tasks.push({ fen, sort });
      }
    }

    let ok = 0;
    let failed = 0;
    let cursor = 0;
    const total = tasks.length;

    const worker = async (): Promise<void> => {
      while (cursor < total) {
        const i = cursor++;
        const { fen, sort } = tasks[i];
        try {
          await this.prewarmOne(fen, 'master', sort);
          ok++;
        } catch (err) {
          failed++;
          this.logger.warn(
            `prewarm failed for fen=${fen} sort=${sort}: ${(err as Error).message}`,
          );
        }
        // Между шагами — пауза, чтобы пул успел отдать connection
        // обратно. Без неё cursor++ цикл моментально берёт следующий
        // FEN, и пул держится «непрерывно занятым».
        if (cursor < total) {
          await sleep(PREWARM_STEP_DELAY_MS);
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(PREWARM_PARALLELISM, total) },
      () => worker(),
    );
    await Promise.all(workers);

    if (ok > 0 || failed > 0) {
      this.logger.log(
        `prewarm: ok=${ok} failed=${failed} parallelism=${PREWARM_PARALLELISM}`,
      );
    }
  }

  async getGameById(id: string): Promise<ArchiveGameDetail> {
    const game = await this.prisma.archiveGame.findUnique({ where: { id } });
    if (!game) {
      throw new NotFoundException(`Archive game ${id} not found`);
    }

    // KS-2074: подтягиваем slug'и обоих игроков из archive_players
    // одним батч-запросом (LEFT JOIN не делаем — у Prisma модели нет
    // relation, проще отдельный SELECT).
    const slugByName = await this.lookupPlayerSlugs([
      game.whiteName,
      game.blackName,
    ]);

    return {
      ...this.toSummary(game, slugByName),
      pgn: game.pgn,
      site: game.site ?? null,
      round: game.round ?? null,
    };
  }

  /**
   * KS-2074: батч-резолвинг slug'ов игроков по `name_canonical`.
   * Возвращает Map<name_canonical, slug>. Имена с null/пустые — пропускаются.
   */
  private async lookupPlayerSlugs(
    names: Array<string | null>,
  ): Promise<Map<string, string>> {
    const unique = [...new Set(names.filter((n): n is string => !!n))];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ name_canonical: string; slug: string }>
    >(
      `SELECT name_canonical, slug FROM archive_players WHERE name_canonical = ANY($1)`,
      unique,
    );
    return new Map(rows.map((r) => [r.name_canonical, r.slug]));
  }

  // ─── Players & events (KS-2065) ──────────────────────────────────

  async searchPlayers(req: {
    q: string;
    limit?: number;
    offset?: number;
  }): Promise<ArchivePlayerSearchResponse> {
    const limit = this.clampLimit(req.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const offset = req.offset && req.offset > 0 ? Math.floor(req.offset) : 0;
    const cacheKey = `arch:players:search:${this.hashQ(req.q, limit, offset)}`;
    const cached = await this.safeGetJson<ArchivePlayerSearchResponse>(cacheKey);
    if (cached) return cached;

    const page = await this.stats.searchPlayers({ q: req.q, limit, offset });
    const response: ArchivePlayerSearchResponse = page;
    await this.safeSetJson(cacheKey, response, PLAYERS_SEARCH_CACHE_TTL_SEC);
    return response;
  }

  async searchEvents(req: {
    q: string;
    limit?: number;
    offset?: number;
  }): Promise<ArchiveEventSearchResponse> {
    const limit = this.clampLimit(req.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const offset = req.offset && req.offset > 0 ? Math.floor(req.offset) : 0;
    const cacheKey = `arch:events:search:${this.hashQ(req.q, limit, offset)}`;
    const cached = await this.safeGetJson<ArchiveEventSearchResponse>(cacheKey);
    if (cached) return cached;

    const page = await this.stats.searchEvents({ q: req.q, limit, offset });
    const response: ArchiveEventSearchResponse = page;
    await this.safeSetJson(cacheKey, response, EVENTS_SEARCH_CACHE_TTL_SEC);
    return response;
  }

  async getPlayerProfile(slug: string): Promise<ArchivePlayerProfileResponse> {
    const cacheKey = `arch:players:profile:${slug}`;
    const cached = await this.safeGetJson<ArchivePlayerProfileResponse>(cacheKey);
    if (cached) return cached;

    const profile = await this.stats.getPlayerProfile(slug);
    if (!profile) {
      throw new NotFoundException(`Archive player ${slug} not found`);
    }
    await this.safeSetJson(cacheKey, profile, PLAYERS_PROFILE_CACHE_TTL_SEC);
    return profile;
  }

  async getPlayerGames(
    slug: string,
    req: Omit<ArchivePlayerGamesRequest, 'slug'>,
  ): Promise<ArchivePlayerGamesResponse> {
    const limit = this.clampLimit(
      req.limit,
      DEFAULT_PLAYER_GAMES_LIMIT,
      MAX_PLAYER_GAMES_LIMIT,
    );
    const offset = req.offset && req.offset > 0 ? Math.floor(req.offset) : 0;
    if (offset > 5000) {
      throw new BadRequestException(
        `offset must be <= 5000 (got ${offset}); use filters for deeper navigation`,
      );
    }
    if (req.minPly != null && req.maxPly != null && req.minPly > req.maxPly) {
      throw new BadRequestException('minPly must be <= maxPly');
    }

    const sort: ArchiveGamesSortMetadata = req.sort ?? 'recent';
    const filtersHash = this.hashPlayerGamesFilters({ ...req, limit, offset, sort });
    const cacheKey = `arch:players:games:${slug}:${filtersHash}`;
    const cached = await this.safeGetJson<ArchivePlayerGamesResponse>(cacheKey);
    if (cached) return cached;

    // KS-2140: skip COUNT(*) для всех player-games запросов — та же
    // archive_games таблица, та же Parallel Seq Scan на фильтрах.
    const opts: SearchPlayerGamesOpts = {
      slug,
      color: req.color,
      result: req.result,
      eco: req.eco,
      event: req.event,
      minElo: req.minElo,
      since: req.since ? new Date(req.since) : undefined,
      until: req.until ? new Date(req.until) : undefined,
      minPly: req.minPly,
      maxPly: req.maxPly,
      timeControlCategory: normalizeTimeControlCategoryFilter(
        req.timeControlCategory,
      ),
      sort,
      limit,
      offset,
      skipTotal: true,
    };

    const page = await this.stats.searchPlayerGames(opts);
    const response: ArchivePlayerGamesResponse = {
      total: null,
      hasNext: page.hasNext,
      items: page.items.map((g) => this.playerGameRowToItem(g)),
    };
    await this.safeSetJson(cacheKey, response, PLAYERS_GAMES_CACHE_TTL_SEC);
    return response;
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  /** Маппит raw-строку из `archive_games` в публичный {@link ArchiveGameSummary}. */
  private rawRowToSummary(r: RawArchiveGameRow): ArchiveGameSummary {
    return {
      id: r.id,
      white: {
        name: r.white_name,
        slug: resolveArchivePlayerSlug(r.white_name, r.white_slug),
        elo: r.white_elo == null ? null : Number(r.white_elo),
        title: r.white_title,
      },
      black: {
        name: r.black_name,
        slug: resolveArchivePlayerSlug(r.black_name, r.black_slug),
        elo: r.black_elo == null ? null : Number(r.black_elo),
        title: r.black_title,
      },
      result: (r.result ?? null) as ArchiveGameResult | null,
      eco: r.eco,
      opening: r.opening,
      event: r.event,
      date: r.played_at ? r.played_at.toISOString() : r.date ?? null,
      plyCount: r.ply_count == null ? null : Number(r.ply_count),
      timeControl: r.time_control ?? null,
      timeControlCategory: normalizeTimeControlCategoryValue(
        r.time_control_category,
      ),
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
      timeControl: string | null;
      timeControlCategory: string | null;
    },
    slugByName: Map<string, string> = new Map(),
  ): ArchiveGameSummary {
    return {
      id: g.id,
      white: {
        name: g.whiteName,
        slug: resolveArchivePlayerSlug(
          g.whiteName,
          g.whiteName ? slugByName.get(g.whiteName) ?? null : null,
        ),
        elo: g.whiteElo,
        title: g.whiteTitle,
      },
      black: {
        name: g.blackName,
        slug: resolveArchivePlayerSlug(
          g.blackName,
          g.blackName ? slugByName.get(g.blackName) ?? null : null,
        ),
        elo: g.blackElo,
        title: g.blackTitle,
      },
      result: (g.result ?? null) as ArchiveGameResult | null,
      eco: g.eco,
      opening: g.opening,
      event: g.event,
      date: g.playedAt ? g.playedAt.toISOString() : g.date ?? null,
      plyCount: g.plyCount,
      timeControl: g.timeControl ?? null,
      timeControlCategory: normalizeTimeControlCategoryValue(
        g.timeControlCategory,
      ),
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

  private hashQ(q: string, limit: number, offset: number): string {
    return createHash('sha1')
      .update(JSON.stringify({ q, limit, offset }))
      .digest('hex')
      .slice(0, 16);
  }

  private hashPlayerGamesFilters(
    req: Omit<ArchivePlayerGamesRequest, 'slug'> & {
      limit: number;
      offset: number;
      sort: ArchiveGamesSortMetadata;
    },
  ): string {
    const canon = JSON.stringify({
      color: req.color ?? null,
      result: req.result ?? null,
      eco: req.eco ?? null,
      event: req.event ?? null,
      minElo: req.minElo ?? null,
      since: req.since ?? null,
      until: req.until ?? null,
      minPly: req.minPly ?? null,
      maxPly: req.maxPly ?? null,
      // KS-2118: важно — массив сортируем для стабильного хэша
      // (?tcc=blitz&tcc=rapid и обратный порядок — один и тот же результат).
      timeControlCategory: normalizeTimeControlCategoryFilter(
        req.timeControlCategory,
      )?.slice().sort() ?? null,
      sort: req.sort,
      limit: req.limit,
      offset: req.offset,
    });
    return createHash('sha1').update(canon).digest('hex').slice(0, 16);
  }

  private playerGameRowToItem(r: RawPlayerGameRow): ArchivePlayerGameItem {
    return {
      id: r.id,
      white: {
        name: r.white_name,
        slug: resolveArchivePlayerSlug(r.white_name, r.white_slug),
        elo: r.white_elo == null ? null : Number(r.white_elo),
        title: r.white_title,
      },
      black: {
        name: r.black_name,
        slug: resolveArchivePlayerSlug(r.black_name, r.black_slug),
        elo: r.black_elo == null ? null : Number(r.black_elo),
        title: r.black_title,
      },
      result: (r.result ?? null) as ArchiveGameResult | null,
      eco: r.eco,
      opening: r.opening,
      event: r.event,
      date: r.played_at ? r.played_at.toISOString() : r.date ?? null,
      plyCount: r.ply_count == null ? null : Number(r.ply_count),
      timeControl: r.time_control ?? null,
      timeControlCategory: normalizeTimeControlCategoryValue(
        r.time_control_category,
      ),
      playerColor: r.player_color,
    };
  }

  private async safeGetJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.warn(`cache read failed (${key}): ${(err as Error).message}`);
      return null;
    }
  }

  private async safeSetJson<T>(key: string, value: T, ttlSec: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSec);
    } catch (err) {
      this.logger.warn(`cache write failed (${key}): ${(err as Error).message}`);
    }
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
   * Invalidates all archive caches on import events.
   * Called in response to the `archive:imported` Redis pub/sub channel
   * (ADR-014 §7, ADR-033 §4.4.7). KS-2065 расширил список паттернов:
   *   - arch:tree:*           — opening tree
   *   - arch:games:*          — games-by-position
   *   - arch:players:*        — players search/profile/games (KS-2065)
   *   - arch:events:*         — events search (KS-2065)
   *
   * A single SCAN would be faster, но `KEYS` для MVP-объёма достаточно
   * и идёт за один батч на каждый паттерн.
   */
  private async invalidateArchiveCache(): Promise<void> {
    await Promise.all([
      this.invalidateTreeCache(),
      this.invalidateByPattern('arch:games:*', 'games-by-position'),
      this.invalidateByPattern('arch:players:*', 'players'),
      this.invalidateByPattern('arch:events:*', 'events'),
    ]);
  }

  /** Generic пакетная инвалидация по KEYS-паттерну. */
  private async invalidateByPattern(pattern: string, label: string): Promise<void> {
    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(...keys);
        this.logger.log(
          `Invalidated ${keys.length} ${label} cache entries after import`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `${label} cache invalidation failed: ${(err as Error).message}`,
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
/**
 * KS-2119. Простой `await sleep(ms)` без зависимости от внешних
 * утилит. `unref` не нужен — Promise завершится раньше выхода Node.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

const TIME_CONTROL_CATEGORY_VALUES = new Set<ArchiveTimeControlCategory>([
  'bullet',
  'blitz',
  'rapid',
  'classical',
  'unknown',
]);

/**
 * KS-2118. Нормализует входной фильтр `?timeControlCategory=...` из DTO в
 * массив валидных категорий. DTO уже валидирует элементы (`@IsIn`),
 * но допускает пропуск — здесь сводим `undefined` / пустой массив к
 * `undefined` (downstream трактует как «фильтр выключен»).
 */
function normalizeTimeControlCategoryFilter(
  raw: ArchiveTimeControlCategory | ArchiveTimeControlCategory[] | undefined,
): ArchiveTimeControlCategory[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const arr = Array.isArray(raw) ? raw : [raw];
  const filtered = arr.filter((v): v is ArchiveTimeControlCategory =>
    TIME_CONTROL_CATEGORY_VALUES.has(v as ArchiveTimeControlCategory),
  );
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * KS-2118. Нормализует значение колонки `time_control_category` из БД
 * в публичный {@link ArchiveTimeControlCategory} | null. Любое
 * неожиданное (не из 5 допустимых) значение сводим к `null` — сильно
 * лучше, чем отдать на фронт мусор. Полностью нулевое поле
 * (NULL в БД) — переходный период до полного backfill, тоже null.
 */
function normalizeTimeControlCategoryValue(
  raw: string | null,
): ArchiveTimeControlCategory | null {
  if (raw == null) return null;
  return TIME_CONTROL_CATEGORY_VALUES.has(raw as ArchiveTimeControlCategory)
    ? (raw as ArchiveTimeControlCategory)
    : null;
}
