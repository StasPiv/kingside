import { PrismaClient, Prisma } from '@kingside/db';
import { ARCHIVE_PLY_LIMIT } from '@kingside/shared';
// Прямой subpath-импорт — из `@kingside/shared` publicly этот символ больше не
// экспортируется, чтобы не тянуть `node:crypto` в браузерный бандл (KS-1597).
import { positionKey } from '@kingside/shared/dist/utils/position-key.js';
import type { ParsedGame } from './pgn-utils.js';
import { positionStatsUpsertDurationSeconds } from './metrics.js';

/**
 * Индексация позиций из недавно добавленных партий.
 *
 * Каждый полуход `ply <= PLY_LIMIT` образует запись в `position_stats` по
 * ключу (`positionKey` от FEN ДО хода, `next_move_uci`, `bucket`). Счётчики
 * исходов (whiteWins/draws/blackWins), общий `total`, скользящее среднее по
 * Elo и `last_seen_at` обновляются инкрементно.
 *
 * Важно: позицию ДО хода считаем из FEN после ПРЕДЫДУЩЕГО хода (для первого
 * хода — стартовая позиция). `positionKey` вычисляется без move-counters,
 * см. `packages/shared/src/utils/position-key.ts`.
 */

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/**
 * Лимит ply для position_stats. Экспортируется, чтобы row-builder и тесты
 * могли проверить инвариант #2 (ply-lock) из ADR-016: оба архивных индекса
 * должны использовать одно и то же значение.
 */
export const PLY_LIMIT = ARCHIVE_PLY_LIMIT;
const DEFAULT_BUCKET = 'master';

/** Дельта по одной (positionKey, move, bucket) — накапливается до UPSERT. */
interface StatsDelta {
  positionKey: Buffer;
  nextMoveUci: string;
  bucket: string;
  whiteWins: number;
  draws: number;
  blackWins: number;
  total: number;
  eloSum: number;
  eloCount: number;
  maxPly: number;
  lastSeenAt: Date;
}

function resultOutcome(result: string | null): 'white' | 'draw' | 'black' | 'unknown' {
  if (result === '1-0') return 'white';
  if (result === '0-1') return 'black';
  if (result === '1/2-1/2') return 'draw';
  return 'unknown';
}

function avgElo(game: ParsedGame): { sum: number; count: number } {
  let sum = 0;
  let count = 0;
  if (game.whiteElo != null) {
    sum += game.whiteElo;
    count++;
  }
  if (game.blackElo != null) {
    sum += game.blackElo;
    count++;
  }
  return { sum, count };
}

export class PositionIndexer {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sourceCode: string,
  ) {}

  /**
   * Агрегируем партии в дельты и применяем UPSERT'ом в один запрос на ключ.
   * `bucket` в MVP фиксирован `master`; позже появится разделение по Elo.
   */
  async index(games: ParsedGame[], bucket = DEFAULT_BUCKET): Promise<void> {
    if (games.length === 0) return;

    await positionStatsUpsertDurationSeconds.time({ source: this.sourceCode }, async () => {
      const deltas = this.collectDeltas(games, bucket);
      if (deltas.size === 0) return;
      await this.applyDeltas(deltas);
    });
  }

  private collectDeltas(games: ParsedGame[], bucket: string): Map<string, StatsDelta> {
    const deltas = new Map<string, StatsDelta>();
    const now = new Date();

    for (const game of games) {
      const outcome = resultOutcome(game.result);
      const { sum: eloSum, count: eloCount } = avgElo(game);
      let fenBefore = STARTING_FEN;

      const limit = Math.min(game.moves.length, PLY_LIMIT);
      for (let ply = 1; ply <= limit; ply++) {
        const move = game.moves[ply - 1];
        const key = positionKey(fenBefore);
        const mapKey = `${key.toString('hex')}|${move.uci}|${bucket}`;
        const existing = deltas.get(mapKey);
        if (existing) {
          existing.total += 1;
          if (outcome === 'white') existing.whiteWins += 1;
          else if (outcome === 'black') existing.blackWins += 1;
          else if (outcome === 'draw') existing.draws += 1;
          existing.eloSum += eloSum;
          existing.eloCount += eloCount;
          if (ply > existing.maxPly) existing.maxPly = ply;
        } else {
          deltas.set(mapKey, {
            positionKey: key,
            nextMoveUci: move.uci,
            bucket,
            whiteWins: outcome === 'white' ? 1 : 0,
            draws: outcome === 'draw' ? 1 : 0,
            blackWins: outcome === 'black' ? 1 : 0,
            total: 1,
            eloSum,
            eloCount,
            maxPly: ply,
            lastSeenAt: now,
          });
        }
        fenBefore = move.fenAfter;
      }
    }

    return deltas;
  }

  /**
   * Применяем дельты к `position_stats`. Используем raw SQL UPSERT
   * (`INSERT ... ON CONFLICT DO UPDATE`) чтобы атомарно мерджить счётчики.
   *
   * avgElo обновляется как скользящее взвешенное среднее:
   *   new_avg = ROUND((old_avg * old_total_with_elo + sum) / (old_total_with_elo + count))
   * Для трэкинга `old_total_with_elo` хранится неявно через сам avg_elo +
   * total — это не 100% точно (MVP), но ADR-013 §8 допускает компромисс.
   * Точное значение потребовало бы отдельной колонки `total_with_elo`;
   * добавим в миграции следующей задачей.
   */
  private async applyDeltas(deltas: Map<string, StatsDelta>): Promise<void> {
    const batchSize = 500;
    const list = [...deltas.values()];
    for (let i = 0; i < list.length; i += batchSize) {
      const chunk = list.slice(i, i + batchSize);
      await this.prisma.$transaction(
        chunk.map((d) => {
          const incomingAvg =
            d.eloCount > 0 ? Math.round(d.eloSum / d.eloCount) : null;
          return this.prisma.$executeRaw(Prisma.sql`
            INSERT INTO position_stats (
              position_key, next_move_uci, bucket,
              white_wins, draws, black_wins, total,
              avg_elo, last_seen_at, ply
            ) VALUES (
              ${d.positionKey}, ${d.nextMoveUci}, ${d.bucket},
              ${d.whiteWins}, ${d.draws}, ${d.blackWins}, ${d.total},
              ${incomingAvg}, ${d.lastSeenAt}, ${d.maxPly}
            )
            ON CONFLICT (position_key, next_move_uci, bucket) DO UPDATE SET
              white_wins = position_stats.white_wins + EXCLUDED.white_wins,
              draws = position_stats.draws + EXCLUDED.draws,
              black_wins = position_stats.black_wins + EXCLUDED.black_wins,
              total = position_stats.total + EXCLUDED.total,
              avg_elo = CASE
                WHEN EXCLUDED.avg_elo IS NULL THEN position_stats.avg_elo
                WHEN position_stats.avg_elo IS NULL THEN EXCLUDED.avg_elo
                ELSE ROUND((position_stats.avg_elo::numeric * position_stats.total + EXCLUDED.avg_elo::numeric * EXCLUDED.total) / NULLIF(position_stats.total + EXCLUDED.total, 0))::int
              END,
              last_seen_at = GREATEST(COALESCE(position_stats.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              ply = LEAST(COALESCE(position_stats.ply, EXCLUDED.ply), EXCLUDED.ply)
          `);
        }),
      );
    }
  }
}
