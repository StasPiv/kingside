import { Injectable, Logger } from '@nestjs/common';
import { Chess } from 'chess.js';
import type {
  ArchiveBucket,
  ArchiveTreeMove,
  ArchiveTreeResponse,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { positionKeyHex } from './position-key';

export type TreeOpts = {
  fen: string;
  bucket: ArchiveBucket;
  minElo?: number;
  since?: Date;
  limit: number;
};

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
}
