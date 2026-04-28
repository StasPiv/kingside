import { Injectable, Logger } from '@nestjs/common';
import { Chess } from 'chess.js';
import type {
  ArchiveBucket,
  ArchiveEventSummary,
  ArchiveGameResult,
  ArchiveGamesByPositionItem,
  ArchiveGamesSort,
  ArchiveGamesSortMetadata,
  ArchivePlayerProfile,
  ArchivePlayerSummary,
  ArchiveTreeMove,
  ArchiveTreeResponse,
} from '@kingside/shared';
import { normalizeArchiveName } from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { positionKeyHex } from './position-key';
import { storageToResult } from './result-format';
import type { ArchiveCursor, RecentCursor, TopEloCursor } from './cursor-codec';

export type TreeOpts = {
  fen: string;
  bucket: ArchiveBucket;
  minElo?: number;
  since?: Date;
  limit: number;
};

export type GamesByPositionOpts = {
  bucket: ArchiveBucket;
  sort: ArchiveGamesSort;
  cursor: ArchiveCursor | null;
  limit: number;
  minElo?: number;
  since?: Date;
  /** Storage-format result ('w'/'b'/'d'/null). `undefined` = filter off. */
  result?: 'w' | 'b' | 'd' | null;
  sideToMove?: 'w' | 'b';
  move?: string;
  player?: string;
  eco?: string;
};

export interface GamesByPositionPage {
  items: ArchiveGamesByPositionItem[];
  /** Raw N+1 row (if present), used by the service to build `nextCursor`. */
  overflow: RawGamePositionRow | null;
}

/** Опции для FTS-поиска по `archive_players` (KS-2065). */
export type SearchPlayersOpts = {
  q: string;
  limit: number;
  offset: number;
};

/** Опции для FTS-поиска по `archive_events` (KS-2065). */
export type SearchEventsOpts = {
  q: string;
  limit: number;
  offset: number;
};

export interface SearchPlayersPage {
  total: number;
  items: ArchivePlayerSummary[];
}

export interface SearchEventsPage {
  total: number;
  items: ArchiveEventSummary[];
}

/** Опции для списка партий игрока (KS-2065). */
export type SearchPlayerGamesOpts = {
  slug: string;
  color?: 'white' | 'black' | 'any';
  result?: ArchiveGameResult;
  eco?: string;
  event?: string;
  minElo?: number;
  since?: Date;
  until?: Date;
  minPly?: number;
  maxPly?: number;
  sort: ArchiveGamesSortMetadata;
  limit: number;
  offset: number;
};

export interface RawPlayerGameRow {
  id: string;
  event: string | null;
  site: string | null;
  round: string | null;
  date: string | null;
  played_at: Date | null;
  white_name: string | null;
  black_name: string | null;
  white_elo: number | null;
  black_elo: number | null;
  white_title: string | null;
  black_title: string | null;
  result: string | null;
  eco: string | null;
  opening: string | null;
  ply_count: number | null;
  player_color: 'white' | 'black';
}

export interface SearchPlayerGamesPage {
  total: number;
  items: RawPlayerGameRow[];
}

/** Опции для metadata-поиска `archive_games` без position-фильтра. */
export type SearchGamesOpts = {
  fen?: string;   // принят DTO, но в metadata-поиске игнорируется (нужен JOIN)
  move?: string;  // то же
  white?: string;
  black?: string;
  player?: string;
  eco?: string;
  event?: string;
  result?: ArchiveGameResult;
  minElo?: number;
  minPly?: number;
  maxPly?: number;
  since?: Date;
  until?: Date;
  sort: ArchiveGamesSortMetadata;
  limit: number;
  offset: number;
};

/** Row shape returned by the metadata search — соответствует столбцам `archive_games`. */
export interface RawArchiveGameRow {
  id: string;
  event: string | null;
  site: string | null;
  round: string | null;
  date: string | null;
  played_at: Date | null;
  white_name: string | null;
  black_name: string | null;
  white_elo: number | null;
  black_elo: number | null;
  white_title: string | null;
  black_title: string | null;
  result: string | null;
  eco: string | null;
  opening: string | null;
  ply_count: number | null;
}

export interface SearchGamesPage {
  total: number;
  items: RawArchiveGameRow[];
}

/** Row shape returned by the JOIN — used internally by the service too. */
export interface RawGamePositionRow {
  game_id: string;
  ply: number;
  move_uci: string | null;
  side_to_move: string;
  played_at: Date | null;
  avg_elo: number | null;
  result: string | null;
  g_white_name: string | null;
  g_black_name: string | null;
  g_white_elo: number | null;
  g_black_elo: number | null;
  g_white_title: string | null;
  g_black_title: string | null;
  g_result: string | null;
  g_eco: string | null;
  g_opening: string | null;
  g_event: string | null;
  g_date: string | null;
  g_played_at: Date | null;
  g_ply_count: number | null;
}

/**
 * Abstraction over the aggregate store that powers the variation tree.
 *
 * The only concrete implementation today is
 * {@link PostgresArchiveStatsRepository}. A future ClickHouse
 * implementation (ADR-013 §10.C.4) will be swapped in via DI without
 * touching the controller or service.
 *
 * NOTE: the interface returns a fully-formed {@link ArchiveTreeResponse}
 * (including SAN) so each backend is free to compute SAN in the most
 * efficient way it has available. Postgres uses chess.js; ClickHouse is
 * expected to pre-materialize SAN column-side.
 */
export interface ArchiveStatsRepository {
  getTree(posKey: Buffer, opts: TreeOpts): Promise<ArchiveTreeResponse>;
  /**
   * Pageable list of games that reached `posKey` — keyset pagination.
   * Returns `N+1` items when available; service decides `hasMore` /
   * `nextCursor` based on that.
   */
  getGamesByPosition(
    posKey: Buffer,
    opts: GamesByPositionOpts,
  ): Promise<GamesByPositionPage>;
  /**
   * Approximate total number of games reaching `posKey`. Uses the
   * aggregate counter in `position_stats` (summed over next moves) so it
   * costs a single index seek regardless of filters.
   */
  countApprox(posKey: Buffer, bucket: ArchiveBucket): Promise<number>;
  /**
   * Top-N (position_key, bucket) pairs by total game count — used by
   * pre-warm. Ordering is deterministic across calls.
   */
  listTopPositions(
    bucket: ArchiveBucket,
    limit: number,
  ): Promise<Array<{ positionKey: Buffer; total: number }>>;
  /**
   * Metadata-search в `archive_games` без position-привязки.
   * Поддерживает фильтры по игроку/eco/event/elo/result/датам/ply и
   * сортировки `recent`/`topElo`/`oldest`. Используется
   * `ArchiveService.getGames` (KS-2063 / ADR-033 §4.2, §4.3).
   */
  searchGames(opts: SearchGamesOpts): Promise<SearchGamesPage>;

  /**
   * KS-2065 / ADR-033 §4.4.4: FTS-поиск по `archive_players`.
   * Возвращает игроков с ранжированием `games_count DESC, similarity DESC`.
   */
  searchPlayers(opts: SearchPlayersOpts): Promise<SearchPlayersPage>;

  /**
   * KS-2065: FTS-поиск по `archive_events`.
   */
  searchEvents(opts: SearchEventsOpts): Promise<SearchEventsPage>;

  /**
   * KS-2065 / ADR-033 §6.3: профиль игрока — JOIN `archive_players` ×
   * MV `archive_player_stats`. Возвращает null, если slug не найден.
   */
  getPlayerProfile(slug: string): Promise<ArchivePlayerProfile | null>;

  /**
   * KS-2065: партии игрока с фильтрами `ArchiveGamesQueryDto` + `color`.
   * JOIN `archive_players` × `archive_games` через `name_canonical`.
   */
  searchPlayerGames(opts: SearchPlayerGamesOpts): Promise<SearchPlayerGamesPage>;
}

export const ARCHIVE_STATS_REPOSITORY = Symbol('ARCHIVE_STATS_REPOSITORY');

type StatsRow = {
  next_move_uci: string;
  white_wins: number;
  draws: number;
  black_wins: number;
  total: number;
  avg_elo: number | null;
  last_seen_at: Date | null;
};

/** Postgres-backed implementation of {@link ArchiveStatsRepository}. */
@Injectable()
export class PostgresArchiveStatsRepository implements ArchiveStatsRepository {
  private readonly logger = new Logger(PostgresArchiveStatsRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async getTree(posKey: Buffer, opts: TreeOpts): Promise<ArchiveTreeResponse> {
    // KS-1692: `totalGames` считается отдельным `SUM(total)` без LIMIT,
    // а не суммированием top-N row'ов из moves-запроса. Прошлая реализация
    // теряла партии с редкими первыми ходами, вылетевшими за `LIMIT`, —
    // это давало расхождение `/tree.totalGames` vs `/games/by-position.
    // totalApprox` для позиций с числом уникальных next_move_uci > LIMIT.
    // Контракт `ArchiveTreeResponse.totalGames` требует полный счёт (см.
    // `packages/shared/src/types/archive.ts:55`: "Total number of games
    // reaching this position").
    const [rows, totalGames] = await Promise.all([
      this.prisma.$queryRawUnsafe<StatsRow[]>(
        `SELECT next_move_uci, white_wins, draws, black_wins, total, avg_elo, last_seen_at
           FROM position_stats
           WHERE position_key = $1 AND bucket = $2
           ORDER BY total DESC
           LIMIT $3`,
        posKey,
        opts.bucket,
        opts.limit,
      ),
      this.countApprox(posKey, opts.bucket),
    ]);

    const moves = rows.map((r) => this.toMove(opts.fen, r));

    return {
      fen: opts.fen,
      positionKey: positionKeyHex(posKey),
      totalGames,
      moves,
      // ECO/opening is resolved by the client (ADR §7). MVP returns null.
      opening: null,
    };
  }

  private toMove(fen: string, row: StatsRow): ArchiveTreeMove {
    const uci = row.next_move_uci;
    const total = Number(row.total);
    const whiteWins = Number(row.white_wins);
    const draws = Number(row.draws);
    const blackWins = Number(row.black_wins);

    return {
      uci,
      san: this.sanFor(fen, uci),
      total,
      whiteWins,
      draws,
      blackWins,
      whitePct: this.pct(whiteWins, total),
      drawPct: this.pct(draws, total),
      blackPct: this.pct(blackWins, total),
      avgElo: row.avg_elo === null ? null : Number(row.avg_elo),
      lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    };
  }

  private pct(part: number, total: number): number {
    if (total <= 0) return 0;
    return Math.round((part * 10000) / total) / 100;
  }

  /**
   * Converts a UCI move to SAN from the given FEN. If the move is illegal
   * for this position (shouldn't happen — the worker validates before
   * inserting), returns the UCI string as a safe fallback so the response
   * still renders.
   */
  private sanFor(fen: string, uci: string): string {
    try {
      const chess = new Chess(fen);
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length >= 5 ? uci.slice(4, 5) : undefined;
      const result = chess.move({ from, to, promotion });
      return result?.san ?? uci;
    } catch (err) {
      this.logger.warn(
        `sanFor: failed to convert ${uci} from ${fen}: ${(err as Error).message}`,
      );
      return uci;
    }
  }

  // ─── Games by position ──────────────────────────────────────────────

  async getGamesByPosition(
    posKey: Buffer,
    opts: GamesByPositionOpts,
  ): Promise<GamesByPositionPage> {
    const sqlBuilder = new KeysetSqlBuilder(posKey, opts);
    const rows = await this.prisma.$queryRawUnsafe<RawGamePositionRow[]>(
      sqlBuilder.sql,
      ...sqlBuilder.params,
    );

    // `LIMIT N+1` — if we got more than N, the extra row flags hasMore.
    let overflow: RawGamePositionRow | null = null;
    if (rows.length > opts.limit) {
      overflow = rows[opts.limit];
      rows.length = opts.limit;
    }

    const items = rows.map(rowToItem);
    return { items, overflow };
  }

  async countApprox(posKey: Buffer, bucket: ArchiveBucket): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ total: bigint | number }>>(
      `SELECT COALESCE(SUM(total), 0)::bigint AS total
         FROM position_stats
         WHERE position_key = $1 AND bucket = $2`,
      posKey,
      bucket,
    );
    const v = rows[0]?.total ?? 0;
    return typeof v === 'bigint' ? Number(v) : Number(v);
  }

  async searchGames(opts: SearchGamesOpts): Promise<SearchGamesPage> {
    const builder = new MetadataSqlBuilder(opts);

    const [items, totals] = await Promise.all([
      this.prisma.$queryRawUnsafe<RawArchiveGameRow[]>(
        builder.itemsSql,
        ...builder.itemsParams,
      ),
      this.prisma.$queryRawUnsafe<Array<{ total: bigint | number }>>(
        builder.totalSql,
        ...builder.whereParams,
      ),
    ]);

    const totalRaw = totals[0]?.total ?? 0;
    const total = typeof totalRaw === 'bigint' ? Number(totalRaw) : Number(totalRaw);
    return { total, items };
  }

  async listTopPositions(
    bucket: ArchiveBucket,
    limit: number,
  ): Promise<Array<{ positionKey: Buffer; total: number }>> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ position_key: Buffer; total: bigint | number }>
    >(
      `SELECT position_key, SUM(total)::bigint AS total
         FROM position_stats
         WHERE bucket = $1
         GROUP BY position_key
         ORDER BY total DESC, position_key DESC
         LIMIT $2`,
      bucket,
      limit,
    );
    return rows.map((r) => ({
      positionKey: Buffer.isBuffer(r.position_key)
        ? r.position_key
        : Buffer.from(r.position_key),
      total: typeof r.total === 'bigint' ? Number(r.total) : Number(r.total),
    }));
  }

  // ─── Players & events search (KS-2065) ────────────────────────────

  async searchPlayers(opts: SearchPlayersOpts): Promise<SearchPlayersPage> {
    return this.searchTrgmEntity({
      table: 'archive_players',
      trgmCol: 'name_aliases',
      orderCol: 'name_normalized',
      q: opts.q,
      limit: opts.limit,
      offset: opts.offset,
      mapRow: (r): ArchivePlayerSummary => ({
        name: r.name_canonical as string,
        slug: r.slug as string,
        gamesCount: Number(r.games_count),
        peakElo: r.peak_elo == null ? null : Number(r.peak_elo),
      }),
      extraSelect: 'peak_elo',
    });
  }

  async searchEvents(opts: SearchEventsOpts): Promise<SearchEventsPage> {
    return this.searchTrgmEntity({
      table: 'archive_events',
      trgmCol: 'name_normalized',
      orderCol: 'name_normalized',
      q: opts.q,
      limit: opts.limit,
      offset: opts.offset,
      mapRow: (r): ArchiveEventSummary => ({
        name: r.name_canonical as string,
        slug: r.slug as string,
        gamesCount: Number(r.games_count),
        firstDate: (r.first_date as string | null) ?? null,
        lastDate: (r.last_date as string | null) ?? null,
      }),
      extraSelect: 'first_date, last_date',
    });
  }

  /**
   * Унифицированный FTS-поиск для players/events. ADR-033 §4.4.4.
   * Использует `pg_trgm` оператор `%` (через GIN-индекс) + prefix-fast
   * path `ILIKE q || '%'`. Сортировка — `games_count DESC, similarity
   * DESC, name_normalized ASC`.
   */
  private async searchTrgmEntity<T>(args: {
    table: 'archive_players' | 'archive_events';
    trgmCol: 'name_aliases' | 'name_normalized';
    orderCol: 'name_normalized';
    q: string;
    limit: number;
    offset: number;
    mapRow: (r: Record<string, unknown>) => T;
    extraSelect: string;
  }): Promise<{ total: number; items: T[] }> {
    const qNorm = normalizeArchiveName(args.q);
    if (!qNorm) {
      return { total: 0, items: [] };
    }

    // WHERE одинаков для items и total.
    const whereSql = `WHERE ${args.trgmCol} % $1 OR ${args.orderCol} ILIKE $1 || '%'`;
    const orderBySql = `
      ORDER BY
        games_count DESC,
        similarity(${args.orderCol}, $1) DESC,
        ${args.orderCol} ASC
    `;

    const itemsSql = `
      SELECT slug, name_canonical, name_normalized, games_count, ${args.extraSelect}
        FROM ${args.table}
        ${whereSql}
        ${orderBySql}
        LIMIT $2 OFFSET $3
    `;
    const totalSql = `
      SELECT COUNT(*)::bigint AS total
        FROM ${args.table}
        ${whereSql}
    `;

    const [rows, totals] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        itemsSql,
        qNorm,
        args.limit,
        args.offset,
      ),
      this.prisma.$queryRawUnsafe<Array<{ total: bigint | number }>>(
        totalSql,
        qNorm,
      ),
    ]);

    const totalRaw = totals[0]?.total ?? 0;
    const total = typeof totalRaw === 'bigint' ? Number(totalRaw) : Number(totalRaw);
    return { total, items: rows.map((r) => args.mapRow(r)) };
  }

  async getPlayerProfile(slug: string): Promise<ArchivePlayerProfile | null> {
    // LEFT JOIN на MV — если у игрока нет ещё ни одной партии в MV (только
    // что добавлен, REFRESH ещё не прошёл), вернём профиль с нулевыми
    // агрегатами и теми first/last_seenAt, что лежат в `archive_players`.
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        slug: string;
        name_canonical: string;
        peak_elo: number | null;
        first_seen_at: Date | null;
        last_seen_at: Date | null;
        games_count: number | bigint | null;
        games_white: number | bigint | null;
        games_black: number | bigint | null;
        wins: number | bigint | null;
        draws: number | bigint | null;
        losses: number | bigint | null;
        s_peak_elo: number | null;
        s_first_seen_at: Date | null;
        s_last_seen_at: Date | null;
      }>
    >(
      `SELECT
         p.slug,
         p.name_canonical,
         p.peak_elo,
         p.first_seen_at,
         p.last_seen_at,
         COALESCE(s.games_count, 0)::int AS games_count,
         COALESCE(s.games_white, 0)::int AS games_white,
         COALESCE(s.games_black, 0)::int AS games_black,
         COALESCE(s.wins, 0)::int AS wins,
         COALESCE(s.draws, 0)::int AS draws,
         COALESCE(s.losses, 0)::int AS losses,
         s.peak_elo AS s_peak_elo,
         s.first_seen_at AS s_first_seen_at,
         s.last_seen_at AS s_last_seen_at
       FROM archive_players p
       LEFT JOIN archive_player_stats s ON s.slug = p.slug
       WHERE p.slug = $1`,
      slug,
    );
    const r = rows[0];
    if (!r) return null;
    const peakElo = r.s_peak_elo ?? r.peak_elo ?? null;
    const firstSeenAt = r.s_first_seen_at ?? r.first_seen_at ?? null;
    const lastSeenAt = r.s_last_seen_at ?? r.last_seen_at ?? null;
    return {
      name: r.name_canonical,
      slug: r.slug,
      gamesCount: Number(r.games_count ?? 0),
      peakElo: peakElo == null ? null : Number(peakElo),
      byColor: {
        white: Number(r.games_white ?? 0),
        black: Number(r.games_black ?? 0),
      },
      byResult: {
        wins: Number(r.wins ?? 0),
        draws: Number(r.draws ?? 0),
        losses: Number(r.losses ?? 0),
      },
      firstSeenAt: firstSeenAt instanceof Date ? firstSeenAt.toISOString() : null,
      lastSeenAt: lastSeenAt instanceof Date ? lastSeenAt.toISOString() : null,
    };
  }

  async searchPlayerGames(opts: SearchPlayerGamesOpts): Promise<SearchPlayerGamesPage> {
    const builder = new PlayerGamesSqlBuilder(opts);
    const [rows, totals] = await Promise.all([
      this.prisma.$queryRawUnsafe<RawPlayerGameRow[]>(
        builder.itemsSql,
        ...builder.itemsParams,
      ),
      this.prisma.$queryRawUnsafe<Array<{ total: bigint | number }>>(
        builder.totalSql,
        ...builder.whereParams,
      ),
    ]);
    const totalRaw = totals[0]?.total ?? 0;
    const total = typeof totalRaw === 'bigint' ? Number(totalRaw) : Number(totalRaw);
    return { total, items: rows };
  }
}

// ─── Query builder ────────────────────────────────────────────────────

/**
 * Builds the parameterized SQL for `archive_game_positions` JOIN
 * `archive_games` with keyset-pagination, filters and `LIMIT N+1`.
 */
class KeysetSqlBuilder {
  public readonly sql: string;
  public readonly params: unknown[] = [];

  constructor(posKey: Buffer, opts: GamesByPositionOpts) {
    // WHERE clauses accumulate into `conds` and $-placeholders follow
    // insertion order; `next()` registers a parameter and returns its ref.
    const conds: string[] = [];

    const pKey = this.register(posKey);
    const pBucket = this.register(opts.bucket);
    conds.push(`p.position_key = ${pKey}`);
    conds.push(`p.bucket = ${pBucket}`);

    // Keyset cursor — see cursor-codec.ts for shape.
    const keyset = this.keysetWhere(opts);
    if (keyset) conds.push(keyset);

    // Index-only filters (live on `archive_game_positions`).
    if (opts.minElo != null) {
      conds.push(`p.avg_elo >= ${this.register(opts.minElo)}`);
    }
    if (opts.since) {
      conds.push(`p.played_at >= ${this.register(opts.since)}`);
    }
    if (opts.result !== undefined) {
      if (opts.result === null) {
        conds.push('p.result IS NULL');
      } else {
        conds.push(`p.result = ${this.register(opts.result)}`);
      }
    }
    if (opts.sideToMove) {
      conds.push(`p.side_to_move = ${this.register(opts.sideToMove)}`);
    }
    if (opts.move) {
      conds.push(`p.move_uci = ${this.register(opts.move)}`);
    }

    // JOIN-based filters (require `archive_games`).
    if (opts.eco) {
      conds.push(`g.eco = ${this.register(opts.eco)}`);
    }
    if (opts.player) {
      const pPlayer = this.register(`%${opts.player}%`);
      conds.push(
        `(g.white_name ILIKE ${pPlayer} OR g.black_name ILIKE ${pPlayer})`,
      );
    }

    const orderBy =
      opts.sort === 'topElo'
        ? 'p.avg_elo DESC NULLS LAST, p.game_id DESC'
        : 'p.played_at DESC NULLS LAST, p.game_id DESC';

    const pLimit = this.register(opts.limit + 1);

    this.sql = `
      SELECT
        p.game_id,
        p.ply,
        p.move_uci,
        p.side_to_move,
        p.played_at,
        p.avg_elo,
        p.result,
        g.white_name AS g_white_name,
        g.black_name AS g_black_name,
        g.white_elo AS g_white_elo,
        g.black_elo AS g_black_elo,
        g.white_title AS g_white_title,
        g.black_title AS g_black_title,
        g.result AS g_result,
        g.eco AS g_eco,
        g.opening AS g_opening,
        g.event AS g_event,
        g.date AS g_date,
        g.played_at AS g_played_at,
        g.ply_count AS g_ply_count
      FROM archive_game_positions p
      JOIN archive_games g ON g.id = p.game_id
      WHERE ${conds.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ${pLimit}
    `;
  }

  private keysetWhere(opts: GamesByPositionOpts): string | null {
    const c = opts.cursor;
    if (!c) return null;

    if (opts.sort === 'recent') {
      const cur = c as RecentCursor;
      if (typeof cur.g !== 'string') return null;
      if (cur.t === null) {
        // Inside the NULLS block — non-null rows already consumed.
        return `p.played_at IS NULL AND p.game_id < ${this.register(cur.g)}::uuid`;
      }
      const pT1 = this.register(new Date(cur.t));
      const pT2 = this.register(new Date(cur.t));
      const pG = this.register(cur.g);
      return `(p.played_at < ${pT1} OR (p.played_at = ${pT2} AND p.game_id < ${pG}::uuid))`;
    }

    const cur = c as TopEloCursor;
    if (typeof cur.g !== 'string') return null;
    if (cur.e === null) {
      return `p.avg_elo IS NULL AND p.game_id < ${this.register(cur.g)}::uuid`;
    }
    const pE1 = this.register(cur.e);
    const pE2 = this.register(cur.e);
    const pG = this.register(cur.g);
    return `(p.avg_elo < ${pE1} OR (p.avg_elo = ${pE2} AND p.game_id < ${pG}::uuid))`;
  }

  private register(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }
}

/**
 * Builds parameterized SQL для `ArchiveStatsRepository.searchGames`
 * (KS-2063 / ADR-033 §4.2). Возвращает 2 SQL: items (LIMIT/OFFSET) и
 * total (COUNT(*) с тем же WHERE). Параметры WHERE общие; для items
 * добавляются ещё два параметра — limit и offset.
 *
 * Сортировки:
 *   - `recent`: `played_at DESC NULLS LAST, id DESC` (используется существующий
 *     индекс `(played_at DESC)`, NULL-партии в хвосте — для устойчивой
 *     keyset-семантики).
 *   - `topElo`: `GREATEST(white_elo, black_elo) DESC NULLS LAST, id DESC`
 *     (индекс `archive_games_top_elo_idx`, миграция KS-2063).
 *   - `oldest`: `played_at ASC NULLS LAST, id ASC` (NULL в конце; иначе пустые
 *     даты пользователю показались бы первыми, что бесполезно).
 */
class MetadataSqlBuilder {
  public readonly itemsSql: string;
  public readonly totalSql: string;
  public readonly itemsParams: unknown[] = [];
  public readonly whereParams: unknown[] = [];

  constructor(opts: SearchGamesOpts) {
    const conds: string[] = [];
    const reg = (v: unknown): string => {
      this.whereParams.push(v);
      return `$${this.whereParams.length}`;
    };

    if (opts.eco) conds.push(`eco = ${reg(opts.eco)}`);
    if (opts.result) conds.push(`result = ${reg(opts.result)}`);
    if (opts.since) conds.push(`played_at >= ${reg(opts.since)}`);
    if (opts.until) conds.push(`played_at <= ${reg(opts.until)}`);
    if (opts.white) {
      conds.push(`white_name ILIKE ${reg(`%${opts.white}%`)}`);
    }
    if (opts.black) {
      conds.push(`black_name ILIKE ${reg(`%${opts.black}%`)}`);
    }
    if (opts.player) {
      const p = reg(`%${opts.player}%`);
      conds.push(`(white_name ILIKE ${p} OR black_name ILIKE ${p})`);
    }
    if (opts.event) {
      conds.push(`event ILIKE ${reg(`%${opts.event}%`)}`);
    }
    if (opts.minElo != null) {
      const e = reg(opts.minElo);
      // Оба игрока должны быть выше порога — иначе фильтр имеет мало смысла.
      conds.push(`white_elo >= ${e} AND black_elo >= ${e}`);
    }
    if (opts.minPly != null) conds.push(`ply_count >= ${reg(opts.minPly)}`);
    if (opts.maxPly != null) conds.push(`ply_count <= ${reg(opts.maxPly)}`);

    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    let orderBy: string;
    switch (opts.sort) {
      case 'topElo':
        orderBy = 'GREATEST(white_elo, black_elo) DESC NULLS LAST, id DESC';
        break;
      case 'oldest':
        orderBy = 'played_at ASC NULLS LAST, id ASC';
        break;
      case 'recent':
      default:
        orderBy = 'played_at DESC NULLS LAST, id DESC';
        break;
    }

    // itemsParams = [...whereParams, limit, offset]; placeholders для
    // limit/offset идут после whereParams.
    this.itemsParams = [...this.whereParams, opts.limit, opts.offset];
    const pLimit = `$${this.whereParams.length + 1}`;
    const pOffset = `$${this.whereParams.length + 2}`;

    this.itemsSql = `
      SELECT
        id, event, site, round, date, played_at,
        white_name, black_name, white_elo, black_elo,
        white_title, black_title, result, eco, opening, ply_count
      FROM archive_games
      ${where}
      ORDER BY ${orderBy}
      LIMIT ${pLimit} OFFSET ${pOffset}
    `;

    this.totalSql = `
      SELECT COUNT(*)::bigint AS total
      FROM archive_games
      ${where}
    `;
  }
}

/**
 * SQL для `searchPlayerGames` (KS-2065). JOIN `archive_players` ×
 * `archive_games` через `name_canonical`. Дополнительно к фильтрам
 * `MetadataSqlBuilder` поддерживает `color` (white/black/any).
 */
class PlayerGamesSqlBuilder {
  public readonly itemsSql: string;
  public readonly totalSql: string;
  public readonly itemsParams: unknown[] = [];
  public readonly whereParams: unknown[] = [];

  constructor(opts: SearchPlayerGamesOpts) {
    const conds: string[] = [];
    const reg = (v: unknown): string => {
      this.whereParams.push(v);
      return `$${this.whereParams.length}`;
    };

    // Slug — обязательный фильтр; идёт первым в whereParams.
    const pSlug = reg(opts.slug);
    conds.push(`p.slug = ${pSlug}`);

    // Color: по умолчанию any — оба цвета (g.white_name = canonical OR g.black_name = canonical).
    if (opts.color === 'white') {
      conds.push(`g.white_name = p.name_canonical`);
    } else if (opts.color === 'black') {
      conds.push(`g.black_name = p.name_canonical`);
    } else {
      conds.push(
        `(g.white_name = p.name_canonical OR g.black_name = p.name_canonical)`,
      );
    }

    if (opts.eco) conds.push(`g.eco = ${reg(opts.eco)}`);
    if (opts.result) conds.push(`g.result = ${reg(opts.result)}`);
    if (opts.since) conds.push(`g.played_at >= ${reg(opts.since)}`);
    if (opts.until) conds.push(`g.played_at <= ${reg(opts.until)}`);
    if (opts.event) {
      conds.push(`g.event ILIKE ${reg(`%${opts.event}%`)}`);
    }
    if (opts.minElo != null) {
      const e = reg(opts.minElo);
      conds.push(`g.white_elo >= ${e} AND g.black_elo >= ${e}`);
    }
    if (opts.minPly != null) conds.push(`g.ply_count >= ${reg(opts.minPly)}`);
    if (opts.maxPly != null) conds.push(`g.ply_count <= ${reg(opts.maxPly)}`);

    const where = `WHERE ${conds.join(' AND ')}`;

    let orderBy: string;
    switch (opts.sort) {
      case 'topElo':
        orderBy = 'GREATEST(g.white_elo, g.black_elo) DESC NULLS LAST, g.id DESC';
        break;
      case 'oldest':
        orderBy = 'g.played_at ASC NULLS LAST, g.id ASC';
        break;
      case 'recent':
      default:
        orderBy = 'g.played_at DESC NULLS LAST, g.id DESC';
        break;
    }

    this.itemsParams = [...this.whereParams, opts.limit, opts.offset];
    const pLimit = `$${this.whereParams.length + 1}`;
    const pOffset = `$${this.whereParams.length + 2}`;

    this.itemsSql = `
      SELECT
        g.id, g.event, g.site, g.round, g.date, g.played_at,
        g.white_name, g.black_name, g.white_elo, g.black_elo,
        g.white_title, g.black_title, g.result, g.eco, g.opening, g.ply_count,
        CASE WHEN g.white_name = p.name_canonical THEN 'white' ELSE 'black' END AS player_color
      FROM archive_players p
      JOIN archive_games g ON (g.white_name = p.name_canonical OR g.black_name = p.name_canonical)
      ${where}
      ORDER BY ${orderBy}
      LIMIT ${pLimit} OFFSET ${pOffset}
    `;

    this.totalSql = `
      SELECT COUNT(*)::bigint AS total
      FROM archive_players p
      JOIN archive_games g ON (g.white_name = p.name_canonical OR g.black_name = p.name_canonical)
      ${where}
    `;
  }
}

function rowToItem(r: RawGamePositionRow): ArchiveGamesByPositionItem {
  const date = r.g_played_at
    ? r.g_played_at.toISOString()
    : (r.g_date ?? null);
  return {
    id: r.game_id,
    white: {
      name: r.g_white_name,
      elo: r.g_white_elo == null ? null : Number(r.g_white_elo),
      title: r.g_white_title,
    },
    black: {
      name: r.g_black_name,
      elo: r.g_black_elo == null ? null : Number(r.g_black_elo),
      title: r.g_black_title,
    },
    // Prefer the canonical wire-format from `archive_games.result` (already
    // `1-0`/`0-1`/`1/2-1/2`/`*`); fall back to translating the CHAR(1)
    // storage from `archive_game_positions.result` if missing.
    result: normalizeResult(r.g_result) ?? storageToResult(r.result),
    eco: r.g_eco,
    opening: r.g_opening,
    event: r.g_event,
    date,
    plyCount: r.g_ply_count == null ? null : Number(r.g_ply_count),
    reachedAtPly: Number(r.ply),
    nextMoveUci: r.move_uci,
    sideToMove: r.side_to_move === 'b' ? 'b' : 'w',
  };
}

function normalizeResult(raw: string | null): '1-0' | '0-1' | '1/2-1/2' | '*' | null {
  if (raw == null) return null;
  if (raw === '1-0' || raw === '0-1' || raw === '1/2-1/2' || raw === '*') {
    return raw;
  }
  return null;
}
