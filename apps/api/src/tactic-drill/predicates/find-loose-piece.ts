/**
 * KS-2227 / ADR-035 §2.1 #6 — `find-loose-piece`.
 *
 * Алгоритм: ищем фигуру противника (не король) у которой нет
 * **прямых** защитников. В позиции должна быть **ровно одна**
 * такая фигура, иначе drop (см. ADR §2.1 строка 6).
 *
 * KS-2349: rollback X-ray-чека из KS-2339. Drill «найди фигуру без
 * защитников» — статический вопрос: пользователь видит на доске
 * прямые защиты, и ожидание именно такое. X-ray (sliding-защитник
 * за блокером) — концепция размена, неуместная для loose-piece.
 *
 * find-undefended-attack продолжает использовать X-ray (там он
 * семантически правилен). find-hanging-piece по KS-2349 тоже
 * откатан на прямую защиту.
 *
 * Сторона на ходу — не важна; «противник» определяется как
 * `oppColor(side-to-move)`, frontend в этом drill side-to-move-
 * индикатор не показывает.
 */

import type { AnswerSquare } from '@kingside/shared';
import { allPieces, oppColor, tryLoadChess, type SquareResult } from './types';

export function findLoosePiece(fen: string): SquareResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const enemy = oppColor(chess.turn());
  const candidates: string[] = [];

  for (const p of allPieces(chess)) {
    if (p.color !== enemy) continue;
    if (p.type === 'k') continue; // король не считается loose
    const defenders = chess.attackers(p.square, enemy);
    if (defenders.length === 0) candidates.push(p.square);
  }

  if (candidates.length !== 1) {
    return {
      valid: false,
      reason: `expected exactly 1 loose piece, found ${candidates.length}`,
    };
  }

  const answer: AnswerSquare = { shape: 'square', square: candidates[0] };
  return { valid: true, answer };
}
