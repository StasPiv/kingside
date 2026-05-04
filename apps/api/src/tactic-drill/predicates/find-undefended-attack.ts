/**
 * KS-2227 / ADR-035 §2.1 #8 — `find-undefended-attack`.
 *
 * Алгоритм: для каждого легального хода `m` стороны на ходу:
 *   1. apply `m`.
 *   2. сверяем — существует ли вражеская фигура (не король), на которую
 *      теперь нападает наш цвет (`attackers(sq, ourColor) ≥ 1`),
 *      причём у которой нет защитников (`attackers(sq, enemyColor) === 0`).
 *   3. undo.
 *
 * Это не съедание (m не должен быть капчой исходной фигуры — но в
 * моменте после m мы создаём угрозу). Чтобы не считать «бесплатное
 * взятие» как «нападение», проверяем что **фигура-цель остаётся на
 * доске после m** (т.е. m не съел её).
 *
 * В позиции должен быть **ровно один** такой ход, иначе drop. Answer-shape
 * — `move` (from + to). Promotion в v1 не используется (генератор
 * отбрасывает позиции с промоушеном).
 */

import type { AnswerMove } from '@kingside/shared';
import type { Square as ChessJsSquare } from 'chess.js';
import { allPieces, oppColor, tryLoadChess, type MoveResult } from './types';
import { hasDirectOrXRayDefender } from './defenders';

export function findUndefendedAttack(fen: string): MoveResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const our = chess.turn();
  const enemy = oppColor(our);
  const candidates: { from: string; to: string }[] = [];

  for (const m of chess.moves({ verbose: true })) {
    // promotion — отбрасываем (v1 не поддерживает).
    if (m.promotion) continue;
    chess.move({ from: m.from, to: m.to });
    let createsThreat = false;
    for (const p of allPieces(chess)) {
      if (p.color !== enemy) continue;
      if (p.type === 'k') continue; // король атакуется = шах, не drill
      const attackers = chess.attackers(p.square, our);
      if (attackers.length < 1) continue;
      // KS-2339: учитываем X-ray защитников. Прямой `attackers(enemy)`
      // не видит sliding piece заблокированную другой фигурой; ход
      // вроде Rc7-c8 на ферзя b8 при ладье d8 ошибочно считался
      // нападением, хотя после взятия Rxb8 ферзь рентгеном защищён.
      if (
        hasDirectOrXRayDefender(chess, p.square as ChessJsSquare, enemy)
      ) {
        continue;
      }
      createsThreat = true;
      break;
    }
    chess.undo();
    if (createsThreat) {
      candidates.push({ from: m.from, to: m.to });
    }
  }

  if (candidates.length !== 1) {
    return {
      valid: false,
      reason: `expected exactly 1 undefended-attacking move, found ${candidates.length}`,
    };
  }

  const answer: AnswerMove = {
    shape: 'move',
    from: candidates[0].from,
    to: candidates[0].to,
  };
  return { valid: true, answer };
}
