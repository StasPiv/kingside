import { Injectable, Logger } from '@nestjs/common';
import { Chess } from 'chess.js';
import type {
  ArchiveBucket,
  ArchiveGamesByPositionItem,
  ArchiveGamesSort,
  ArchiveTreeMove,
  ArchiveTreeResponse,
} from '@kingside/shared';
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
    const rows = await this.prisma.$queryRawUnsafe<StatsRow[]>(
      `SELECT next_move_uci, white_wins, draws, black_wins, total, avg_elo, last_seen_at
         FROM position_stats
         WHERE position_key = $1 AND bucket = $2
         ORDER BY total DESC
         LIMIT $3`,
      posKey,
      opts.bucket,
      opts.limit,
    );

    const totalGames = rows.reduce((sum, r) => sum + Number(r.total), 0);
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
