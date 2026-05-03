/**
 * KS-2227 / ADR-035 §2.1 #5 — `find-mate-in-one-square`.
 *
 * KS-2320 / KS-2321: shape переведён со `square` на `move`.
 * Strict-uniqueness теперь по полной паре `(from, to)`, а не только
 * по `to`-клетке. Это закрывает два ранее допустимых случая:
 *   1. **Две разные фигуры на одну `to`-клетку** — раньше предикат
 *      проверял `unique to`, такой случай мог пройти. Теперь — drop.
 *   2. **Одна фигура с разных стартовых клеток** (например, два коня
 *      обе бьют на одну клетку и обе матуют) — drop.
 *
 * Алгоритм: перебираем все легальные ходы стороны на ходу. Для каждого
 * хода делаем `chess.move(...)`, проверяем `isCheckmate()`, откатываем
 * через `undo()`. Собираем матующие пары `(from, to)`. Уникальность —
 * по канонической строке `from+to+promotion?`.
 *
 * Инварианты (ADR §2.1 строка 5 + KS-2320):
 *  - В позиции должна быть **ровно одна** уникальная пара матующих
 *    `(from, to[, promotion])`.
 *  - Promotion в drill v1 не используется (генератор отбрасывает
 *    позиции с промоушеном). Если матующий ход — promotion — тоже drop.
 *
 * Answer-shape — `'move'` (KS-2321). Возвращаем `{from, to}` без
 * promotion'а.
 */

import type { AnswerMove } from '@kingside/shared';
import { tryLoadChess, type MoveResult } from './types';

export function findMateInOneSquare(fen: string): MoveResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const matingMoves: { from: string; to: string }[] = [];
  for (const m of chess.moves({ verbose: true })) {
    // KS-2321: drill v1 без promotion'ов — позиции, в которых
    // матующий ход является promotion, отбрасываем.
    if (m.promotion) continue;
    chess.move({ from: m.from, to: m.to });
    if (chess.isCheckmate()) {
      matingMoves.push({ from: m.from, to: m.to });
    }
    chess.undo();
  }

  // Дедуп по полной паре (from, to). Если в нашем списке сейчас один
  // и тот же ход повторился из-за внешнего стохастика chess.js — Set
  // схлопнёт, но ожидаемо у нас длина уже = unique-count.
  const uniqueKeys = new Set(matingMoves.map((m) => `${m.from}${m.to}`));
  if (uniqueKeys.size !== 1) {
    return {
      valid: false,
      reason: `expected exactly 1 mating move, found ${uniqueKeys.size}`,
    };
  }

  const [only] = matingMoves;
  const answer: AnswerMove = {
    shape: 'move',
    from: only.from,
    to: only.to,
  };
  return { valid: true, answer };
}
