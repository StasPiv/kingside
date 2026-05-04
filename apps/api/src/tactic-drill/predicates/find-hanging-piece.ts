/**
 * KS-2227 / KS-2335 / KS-2337 — `find-hanging-piece`.
 *
 * Семантика (после KS-2335): «возьми незащищённую (висящую) фигуру
 * противника одним ходом». Ответ — `{shape:'move', from, to}`.
 *
 * Алгоритм:
 *   1. Найти кандидатов-цели: вражеская фигура (не король),
 *      `attackers(sq, our) ≥ 1` и `attackers(sq, enemy) === 0`.
 *      Если их **не ровно 1** — drop (как в KS-2227).
 *   2. Собрать все легальные ходы-взятия этой цели через
 *      `chess.moves({verbose:true})` (chess.js фильтрует ходы,
 *      открывающие нашего короля). Promotion-взятие в v1 не
 *      поддерживаем — отбрасываем.
 *   3. **Strict-uniqueness по (from, to)**: должно быть ровно
 *      одно такое взятие. Если 2+ наших фигур атакуют цель и обе
 *      могут законно взять — ответ неоднозначен → drop.
 *
 * Сторона на ходу важна (drill «возьми у противника»); «наш» цвет = `chess.turn()`.
 */

import type { AnswerMove } from '@kingside/shared';
import { allPieces, oppColor, tryLoadChess, type MoveResult } from './types';

export function findHangingPiece(fen: string): MoveResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const our = chess.turn();
  const enemy = oppColor(our);

  // 1. Кандидаты-цели.
  const targets: string[] = [];
  for (const p of allPieces(chess)) {
    if (p.color !== enemy) continue;
    if (p.type === 'k') continue;
    const attackers = chess.attackers(p.square, our);
    const defenders = chess.attackers(p.square, enemy);
    if (attackers.length >= 1 && defenders.length === 0) {
      targets.push(p.square);
    }
  }
  if (targets.length !== 1) {
    return {
      valid: false,
      reason: `expected exactly 1 hanging target, found ${targets.length}`,
    };
  }
  const target = targets[0];

  // 2. Легальные ходы-взятия цели. promotion отбрасываем (v1).
  const captures = chess.moves({ verbose: true }).filter(
    (m) =>
      m.to === target &&
      m.captured !== undefined &&
      !m.promotion,
  );

  // 3. Strict-uniqueness по (from, to). Если 2+ — drop.
  if (captures.length !== 1) {
    return {
      valid: false,
      reason: `expected exactly 1 capture move, found ${captures.length}`,
    };
  }

  const m = captures[0];
  const answer: AnswerMove = { shape: 'move', from: m.from, to: m.to };
  return { valid: true, answer };
}
