/**
 * KS-2227 / ADR-035 §2.1 #5 — `find-mate-in-one-square`.
 *
 * Алгоритм: перебираем все легальные ходы стороны на ходу. Для каждого
 * хода делаем `chess.move(...)`, проверяем `isCheckmate()`, откатываем
 * через `undo()`. Собираем матующие ходы.
 *
 * Инварианты (ADR §2.1 строка 5 + KS-2223 §8.3):
 *  - В позиции должен быть **ровно один** матующий ход.
 *  - Дополнительно: если две **разные** фигуры могут поставить мат на
 *    разные `to`-клетки — drop (при `length === 1` это автоматически
 *    выполнено; правило защищает от случаев, когда к нам просочилось
 *    >1 матующих ходов с разными `to`).
 *
 * Answer-shape — строго `square` (KS-2223 §8.3 отменил fallback на
 * `move`). Возвращаем `to`-клетку.
 */

import type { AnswerSquare } from '@kingside/shared';
import { tryLoadChess, type SquareResult } from './types';

export function findMateInOneSquare(fen: string): SquareResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const matingMoves: { from: string; to: string }[] = [];

  for (const m of chess.moves({ verbose: true })) {
    chess.move({ from: m.from, to: m.to, promotion: m.promotion });
    if (chess.isCheckmate()) {
      matingMoves.push({ from: m.from, to: m.to });
    }
    chess.undo();
  }

  if (matingMoves.length !== 1) {
    return {
      valid: false,
      reason: `expected exactly 1 mating move, found ${matingMoves.length}`,
    };
  }

  const answer: AnswerSquare = {
    shape: 'square',
    square: matingMoves[0].to,
  };
  return { valid: true, answer };
}
