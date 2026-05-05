/**
 * KS-2227 / KS-2335 / KS-2337 / KS-2349 / KS-2371 — `find-hanging-piece`.
 *
 * Семантика (после KS-2335): «возьми незащищённую (висящую) фигуру
 * противника одним ходом». Ответ — `{shape:'move', from, to}`.
 *
 * Алгоритм:
 *   1. Найти кандидатов-цели: вражеская фигура (не король),
 *      `attackers(sq, our) ≥ 1` и `attackers(sq, enemy) === 0`
 *      (только прямые защитники; KS-2349 rollback X-ray из KS-2339).
 *      Если кандидатов **не ровно 1** — drop (как в KS-2227).
 *   2. Собрать все легальные ходы-взятия этой цели через
 *      `chess.moves({verbose:true})` (chess.js фильтрует ходы,
 *      открывающие нашего короля). Promotion-взятие в v1 не
 *      поддерживаем — отбрасываем.
 *   3. **Strict-uniqueness по (from, to)**: должно быть ровно
 *      одно такое взятие. Если 2+ наших фигур атакуют цель и обе
 *      могут законно взять — ответ неоднозначен → drop.
 *   4. **KS-2371: post-capture safety check** — применить ход в
 *      chess.js, проверить, что атакующая фигура на target-клетке
 *      не находится под атакой противника (включая X-ray, который
 *      становится прямым после исчезновения цели). Если есть —
 *      это размен, не безнаказанное взятие → drop.
 *
 *      Это локальная проверка только для этого predicate; не
 *      переиспользуется helper из defenders.ts (`hasDirectOrXRay
 *      Defender`), который KS-2349 убрал из этого predicate'а
 *      из-за false-positive в drill loose-piece. Здесь же
 *      `chess.attackers(target, enemy)` после `chess.move(...)`
 *      даёт **прямую** проверку attackers, X-ray-эффект учитывается
 *      автоматически (фигура на target открывает или нет другие
 *      линии атаки).
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

  // 1. Кандидаты-цели. KS-2349: rollback X-ray-чека (KS-2339) — для
  // визуального drill'а пользователь видит прямые защиты на доске;
  // X-ray-семантика остаётся только в find-undefended-attack.
  const targets: string[] = [];
  for (const p of allPieces(chess)) {
    if (p.color !== enemy) continue;
    if (p.type === 'k') continue;
    const attackers = chess.attackers(p.square, our);
    if (attackers.length < 1) continue;
    const defenders = chess.attackers(p.square, enemy);
    if (defenders.length > 0) continue;
    targets.push(p.square);
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

  // 4. KS-2371: безнаказанное ли взятие? Применяем ход и смотрим,
  //    атакована ли наша фигура на target. Если да — размен, drop.
  //    `chess.attackers` после move уже учитывает геометрию X-ray
  //    (sliding piece по линии становится прямым атакующим, когда
  //    блокировавшая фигура ушла на target).
  chess.move({ from: m.from, to: m.to });
  const attackersAfter = chess.attackers(target as never, enemy);
  chess.undo();
  if (attackersAfter.length > 0) {
    return {
      valid: false,
      reason: `capture is exchange (attackers on ${target} after move: ${attackersAfter.length})`,
    };
  }

  const answer: AnswerMove = { shape: 'move', from: m.from, to: m.to };
  return { valid: true, answer };
}
