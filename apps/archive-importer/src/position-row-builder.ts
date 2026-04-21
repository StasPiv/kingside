/**
 * Построение строк для таблицы `archive_game_positions` (ADR-014 §1.2, §5).
 *
 * На одну партию сохраняется одна строка на каждую уникальную позицию для
 * ply ≤ `POSITION_PLY_LIMIT` (= `ARCHIVE_PLY_LIMIT`). Первичный ключ
 * (position_key, bucket, game_id) —
 * транспозиции в рамках одной партии сворачиваются в одну строку; берётся
 * первая встреча (минимальный ply).
 *
 * Запись строк в БД реализует `ArchivePositionWriter` (pg + COPY FROM STDIN
 * через staging TEMP TABLE с `ON CONFLICT DO NOTHING`).
 */

import { ARCHIVE_PLY_LIMIT } from '@kingside/shared';
import { positionKey } from '@kingside/shared/dist/utils/position-key.js';
import type { ParsedGame } from './pgn-utils.js';

/**
 * До какого ply включительно индексируем позиции в `archive_game_positions`.
 * ply 0 — стартовая. Значение должно совпадать с `PLY_LIMIT` из
 * `position-indexer.ts` — инвариант #2 (ply-lock) из ADR-016. Для этого
 * обе константы проксируются через `ARCHIVE_PLY_LIMIT` из `@kingside/shared`.
 */
export const POSITION_PLY_LIMIT = ARCHIVE_PLY_LIMIT;

/** Стартовый FEN; совпадает с PositionIndexer. */
const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export interface PositionRow {
  /** 16 байт position_key (см. packages/shared/src/utils/position-key.ts). */
  positionKey: Buffer;
  bucket: string;
  /** UUID партии (строкой). */
  gameId: string;
  /** Ply встречи позиции; 0 = стартовая. */
  ply: number;
  /** Следующий ход из этой позиции в UCI или null (если партия закончилась). */
  moveUci: string | null;
  /** Сторона, которой ходить в позиции. */
  sideToMove: 'w' | 'b';
  /** ISO-дата партии (денормализация для сортировки без JOIN). */
  playedAt: Date | null;
  /** Средний Elo обоих игроков (null если хотя бы один не указан). */
  avgElo: number | null;
  /** Результат партии в char(1): 'w'/'b'/'d' или null для '*'/unknown. */
  result: string | null;
}

/** Средний Elo двух игроков или null, если хотя бы у одного не проставлен. */
function averageElo(game: ParsedGame): number | null {
  if (game.whiteElo == null || game.blackElo == null) return null;
  return Math.round((game.whiteElo + game.blackElo) / 2);
}

/** Маппинг результата партии в char(1). '*' и неизвестные → null. */
export function normalizeResult(result: string | null): 'w' | 'b' | 'd' | null {
  if (result === '1-0') return 'w';
  if (result === '0-1') return 'b';
  if (result === '1/2-1/2') return 'd';
  return null;
}

/** Сторона, которой ходить — второе поле FEN. */
function sideToMoveFromFen(fen: string): 'w' | 'b' {
  const parts = fen.split(' ');
  return parts[1] === 'b' ? 'b' : 'w';
}

/**
 * Собирает строки archive_game_positions для одной партии.
 *
 * Дедуп по `positionKey`: если одна и та же позиция встретилась дважды
 * (транспозиция), остаётся первая встреча (минимальный ply).
 * Все строки ограничены `ply ≤ POSITION_PLY_LIMIT`.
 */
export function buildPositionRowsForGame(
  gameId: string,
  game: ParsedGame,
  bucket: string,
): PositionRow[] {
  // KS-1624: партии с нестандартной стартовой позицией (`[SetUp "1"][FEN]`)
  // не входят в классическое дерево дебютов — их позиции не сохраняем в
  // `archive_game_positions`. Ply-lock инвариант с `PositionIndexer`
  // сохраняется: обе структуры пропускают такие партии одинаково.
  if (game.startFen) return [];

  const avgElo = averageElo(game);
  const result = normalizeResult(game.result);
  const playedAt = game.playedAt;

  const rows: PositionRow[] = [];
  const seen = new Set<string>();

  const totalPly = game.moves.length;
  const limit = Math.min(totalPly, POSITION_PLY_LIMIT);

  // ply 0..limit (позиция ДО ply-го полухода, limit ходов учитываем).
  // Для ply = totalPly нет следующего хода (игра окончена) — moveUci = null.
  for (let ply = 0; ply <= limit; ply++) {
    const fen = ply === 0 ? STARTING_FEN : game.moves[ply - 1].fenAfter;
    const key = positionKey(fen);
    const hex = key.toString('hex');
    if (seen.has(hex)) continue;
    seen.add(hex);

    const nextMove = ply < totalPly ? game.moves[ply].uci : null;
    rows.push({
      positionKey: key,
      bucket,
      gameId,
      ply,
      moveUci: nextMove,
      sideToMove: sideToMoveFromFen(fen),
      playedAt,
      avgElo,
      result,
    });
  }

  return rows;
}

/**
 * Сериализация одной строки в CSV для COPY FROM STDIN (FORMAT CSV).
 *
 * Порядок колонок должен совпадать с DDL TEMP-таблицы в writer'е:
 *   position_key, bucket, game_id, ply, move_uci, side_to_move,
 *   played_at, avg_elo, result.
 *
 * BYTEA пишется как `\xHEX` — PostgreSQL парсит это как bytea hex-input.
 * NULL сериализуется как пустое поле (COPY ... WITH NULL '').
 */
export function serializePositionRowCsv(row: PositionRow): string {
  const parts = [
    '\\x' + row.positionKey.toString('hex'),
    csvField(row.bucket),
    row.gameId,
    String(row.ply),
    csvField(row.moveUci),
    row.sideToMove,
    row.playedAt ? row.playedAt.toISOString() : '',
    row.avgElo != null ? String(row.avgElo) : '',
    row.result ?? '',
  ];
  return parts.join(',') + '\n';
}

function csvField(v: string | null): string {
  if (v === null) return '';
  if (/["\n\r,]/.test(v)) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}
