/**
 * KS-2227 / ADR-035 §2.1 #4 — `find-fork`.
 *
 * Алгоритм: для каждой фигуры F стороны на ходу собрать множество
 * атакуемых **ценных** фигур противника (`value ≥ minor`, т.е.
 * `n/b/r/q/k`; пешки исключены). Если |attacked enemy pieces ≥ 2| ≥ 2
 * — F делает вилку. В позиции должна быть **ровно одна** такая F,
 * иначе drop (ADR §2.1 строка 4: «фигура, делающая вилку»).
 *
 * Реализация через `chess.attackers(targetSq, ourColor)`: для каждой
 * вражеской ценной фигуры спрашиваем «кто её атакует моим цветом» —
 * и накапливаем «нападает ли F на эту цель» в map F→Set<targetSq>.
 *
 * KS-2223 §8.1 / methodology §2.2: «двойной удар» / double-attack —
 * шире вилки и зарезервирован для v2; здесь именно вилка.
 */

import type { AnswerSquare } from '@kingside/shared';
import {
  PIECE_VALUE,
  allPieces,
  oppColor,
  tryLoadChess,
  type SquareResult,
} from './types';

export function findFork(fen: string): SquareResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const our = chess.turn();
  const enemy = oppColor(our);

  // F → Set атакуемых ценных вражеских клеток.
  const forkers = new Map<string, Set<string>>();

  for (const p of allPieces(chess)) {
    if (p.color !== enemy) continue;
    // ценные фигуры (≥ minor): n/b/r/q/k
    if (PIECE_VALUE[p.type] < 3) continue;
    const attackers = chess.attackers(p.square, our);
    for (const fSq of attackers) {
      if (!forkers.has(fSq)) forkers.set(fSq, new Set());
      forkers.get(fSq)!.add(p.square);
    }
  }

  const candidates: string[] = [];
  for (const [fSq, targets] of forkers) {
    if (targets.size >= 2) candidates.push(fSq);
  }

  if (candidates.length !== 1) {
    return {
      valid: false,
      reason: `expected exactly 1 forker, found ${candidates.length}`,
    };
  }

  const answer: AnswerSquare = { shape: 'square', square: candidates[0] };
  return { valid: true, answer };
}
