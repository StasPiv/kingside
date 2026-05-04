/**
 * KS-2227 / KS-2372 — `find-undefended-attack`.
 *
 * Семантика: «найти ход стороны на ходу, который **создаёт** новую
 * угрозу взятия незащищённой фигуры противника». Угроза должна быть
 * **новой** — то есть не существовать в позиции ДО хода. Если фигура
 * противника уже была без защитников и под боем — это пассивная
 * висящая, не "создание угрозы". Ответ — `{shape:'move', from, to}`.
 *
 * KS-2372 изменения:
 * 1. Убрана `hasDirectOrXRayDefender` (X-ray helper из KS-2339).
 *    Используем только прямые `chess.attackers` после `chess.move` —
 *    chess.js автоматически учитывает геометрию открытых линий после
 *    хода без отдельного X-ray-helper'а.
 * 2. Добавлена проверка **новизны угрозы**: snapshot множества висящих
 *    enemy-фигур ДО любого хода. После apply m — собираем такой же
 *    snapshot. Кандидатом считаем ход только если в `threatsAfter`
 *    появилась клетка, отсутствовавшая в `threatsBefore`.
 *
 * Алгоритм:
 *   1. До цикла по ходам: соберём `threatsBefore: Set<square>` =
 *      enemy-фигуры (не король) с attackers(our) ≥ 1 И
 *      defenders(enemy) = 0.
 *   2. Для каждого легального хода m:
 *      a. apply m.
 *      b. Собрать `threatsAfter` тем же способом.
 *      c. Если есть square ∈ threatsAfter \ threatsBefore — m кандидат.
 *      d. undo.
 *   3. Strict-uniqueness: ровно 1 такой ход, иначе drop.
 *
 * Promotion отбрасываем (v1).
 */

import type { AnswerMove } from '@kingside/shared';
import { Chess } from 'chess.js';
import { allPieces, oppColor, tryLoadChess, type MoveResult } from './types';

function collectUndefendedThreats(
  chess: Chess,
  our: 'w' | 'b',
  enemy: 'w' | 'b',
): Set<string> {
  const out = new Set<string>();
  for (const p of allPieces(chess)) {
    if (p.color !== enemy) continue;
    if (p.type === 'k') continue; // король = шах, не drill
    const attackers = chess.attackers(p.square, our);
    if (attackers.length < 1) continue;
    const defenders = chess.attackers(p.square, enemy);
    if (defenders.length > 0) continue;
    out.add(p.square);
  }
  return out;
}

export function findUndefendedAttack(fen: string): MoveResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const our = chess.turn();
  const enemy = oppColor(our);

  // KS-2372: snapshot уже-висящих фигур противника ДО хода. Будем
  // искать ходы, добавляющие новую угрозу.
  const threatsBefore = collectUndefendedThreats(chess, our, enemy);

  const candidates: { from: string; to: string }[] = [];

  for (const m of chess.moves({ verbose: true })) {
    // promotion — отбрасываем (v1 не поддерживает).
    if (m.promotion) continue;
    chess.move({ from: m.from, to: m.to });
    const threatsAfter = collectUndefendedThreats(chess, our, enemy);
    chess.undo();

    // Новая угроза = клетка в After, отсутствующая в Before.
    let createsNew = false;
    for (const sq of threatsAfter) {
      if (!threatsBefore.has(sq)) {
        createsNew = true;
        break;
      }
    }
    if (createsNew) {
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
