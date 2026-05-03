/**
 * KS-2227 / ADR-035 §2.1 #1 — `find-hanging-piece`.
 *
 * Алгоритм: ищем фигуру противника (не король), на которую можно
 * безнаказанно напасть — `attackers(sq, ourColor) ≥ 1` И
 * `attackers(sq, enemyColor) = 0`. В позиции должна быть **ровно одна**
 * такая фигура, иначе drop (ADR §2.1 строка 1).
 *
 * Сторона на ходу важна (drill «Какая фигура висит?»); «наш» цвет = `chess.turn()`.
 */

import type { AnswerSquare } from '@kingside/shared';
import { allPieces, oppColor, tryLoadChess, type SquareResult } from './types';

export function findHangingPiece(fen: string): SquareResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const our = chess.turn();
  const enemy = oppColor(our);
  const candidates: string[] = [];

  for (const p of allPieces(chess)) {
    if (p.color !== enemy) continue;
    if (p.type === 'k') continue; // король исключён
    const attackers = chess.attackers(p.square, our);
    const defenders = chess.attackers(p.square, enemy);
    if (attackers.length >= 1 && defenders.length === 0) {
      candidates.push(p.square);
    }
  }

  if (candidates.length !== 1) {
    return {
      valid: false,
      reason: `expected exactly 1 hanging piece, found ${candidates.length}`,
    };
  }

  const answer: AnswerSquare = { shape: 'square', square: candidates[0] };
  return { valid: true, answer };
}
