/**
 * KS-2227 (ADR-035 §2.1, §6, Drills E2). Общие типы и хелперы для
 * 8 предикатов распознавания тактических паттернов.
 *
 * Каждый предикат на вход принимает FEN (некоторые — дополнительные
 * параметры вроде `targetSquare` для `count-attackers`) и возвращает
 * `PredicateResult<T>`:
 *   - `valid: true, answer: T` — позиция подходит под drill, эталон
 *     зафиксирован;
 *   - `valid: false, reason?` — позиция отбрасывается (не подходит,
 *     неоднозначна, нарушает инвариант). `reason` опционально для
 *     индексатора-логирования (KS-DRILL-INDEXER).
 *
 * Все ответы имеют формат api-contract §3 (`AnswerData` discriminated
 * union: `square` / `squares` / `number` / `move`). Здесь они
 * импортируются из `@kingside/shared`, единый источник истины.
 */

import { Chess, type Color, type Square as ChessJsSquare } from 'chess.js';
import type {
  AnswerData,
  AnswerMove,
  AnswerNumber,
  AnswerSquare,
  AnswerSquares,
} from '@kingside/shared';

/** Универсальная форма результата предиката. */
export type PredicateResult<T extends AnswerData> =
  | { valid: true; answer: T }
  | { valid: false; reason?: string };

export type SquareResult = PredicateResult<AnswerSquare>;
export type SquaresResult = PredicateResult<AnswerSquares>;
export type NumberResult = PredicateResult<AnswerNumber>;
export type MoveResult = PredicateResult<AnswerMove>;

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Безопасно создаёт `Chess`-инстанс из FEN. Возвращает `null` если FEN
 * невалидный — предикат-вызыватель должен решить, считать это
 * `valid:false` или ошибкой индексатора.
 */
export function tryLoadChess(fen: string): Chess | null {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

/** Противоположный цвет. */
export function oppColor(c: Color): Color {
  return c === 'w' ? 'b' : 'w';
}

/**
 * Минимальная piece-value для отбора «ценных» фигур в `find-fork`
 * (ADR-035 §2.1: «ценные ≥ minor»). Pawn — value 1, не считается ценным.
 * King — `Infinity`, всегда ценен.
 */
export const PIECE_VALUE: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: Infinity,
};

/** Все 64 клетки доски в формате `<file><rank>`. */
export const ALL_SQUARES: ChessJsSquare[] = (() => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const out: ChessJsSquare[] = [];
  for (const f of files) {
    for (let r = 1; r <= 8; r++) out.push(`${f}${r}` as ChessJsSquare);
  }
  return out;
})();

/**
 * Перебор всех непустых клеток с фигурами. Удобно для предикатов,
 * где нужно итерировать «по фигурам на доске».
 */
export interface BoardEntry {
  square: ChessJsSquare;
  type: 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
  color: Color;
}

export function allPieces(chess: Chess): BoardEntry[] {
  const out: BoardEntry[] = [];
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      out.push({ square: cell.square, type: cell.type, color: cell.color });
    }
  }
  return out;
}

/** Найти клетку короля. */
export function findKingSquare(
  chess: Chess,
  color: Color,
): ChessJsSquare | null {
  for (const p of allPieces(chess)) {
    if (p.type === 'k' && p.color === color) return p.square;
  }
  return null;
}
