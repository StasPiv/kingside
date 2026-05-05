/**
 * KS-2227 / KS-2372 / KS-2419 — `find-undefended-attack`.
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
 * KS-2419 — safety-check атакующей фигуры. Запрос пользователя:
 * «исключить ходы под бой». До патча predicate возвращал и Qxh7,
 * где ферзь после взятия пешки попадает под атаку короля без
 * защитника — формально создаётся «новая угроза», но реально это
 * зевок ферзя, не тренировка тактики. Простая v1 (как в KS-2406):
 * если на клетке `m.to` после хода есть хоть один прямой
 * enemy-attacker — кандидат отбрасывается. Без SEE; промежуточный
 * кейс «атакован, но защищён равной фигурой» отбрасывается тоже
 * (consistency со spec). Король-атакующий: chess.js не пускает
 * под шах, отдельной проверки не нужно.
 *
 * При drop'е возвращаем `reason: 'unsafe-attacker'` если до safety-
 * фильтра был ровно 1 creator-кандидат, а после фильтра — 0.
 * Индексер использует это для счётчика отсева в логах.
 *
 * Алгоритм:
 *   1. До цикла: соберём `threatsBefore: Set<square>` =
 *      enemy-фигуры (не король) с attackers(our) ≥ 1 И
 *      defenders(enemy) = 0.
 *   2. Для каждого легального хода m:
 *      a. apply m.
 *      b. Собрать `threatsAfter` тем же способом.
 *      c. Если есть square ∈ threatsAfter \ threatsBefore — m creator.
 *      d. KS-2419: safety-check на m.to (есть ли enemy-attacker).
 *      e. undo.
 *   3. Strict-uniqueness: ровно 1 safe creator, иначе drop.
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

  // KS-2419 буфера для отчётности:
  //   creatorCandidates — ходы, создающие новую угрозу (диф ≠ ∅).
  //   safeCandidates — creatorCandidates ∩ safe (атакующая на m.to
  //     без enemy-attacker'ов).
  const creatorCandidates: { from: string; to: string }[] = [];
  const safeCandidates: { from: string; to: string }[] = [];

  for (const m of chess.moves({ verbose: true })) {
    // promotion — отбрасываем (v1 не поддерживает).
    if (m.promotion) continue;
    chess.move({ from: m.from, to: m.to });
    const threatsAfter = collectUndefendedThreats(chess, our, enemy);

    // Новая угроза = клетка в After, отсутствующая в Before.
    let createsNew = false;
    for (const sq of threatsAfter) {
      if (!threatsBefore.has(sq)) {
        createsNew = true;
        break;
      }
    }
    let attackerSafe = false;
    if (createsNew) {
      // KS-2419 safety: «есть хоть один enemy-attacker на m.to → drop».
      // Простая v1, как в KS-2406 для find-fork.
      const enemyAttackers = chess.attackers(m.to, enemy);
      attackerSafe = enemyAttackers.length === 0;
    }
    chess.undo();

    if (createsNew) {
      creatorCandidates.push({ from: m.from, to: m.to });
      if (attackerSafe) safeCandidates.push({ from: m.from, to: m.to });
    }
  }

  if (safeCandidates.length !== 1) {
    // KS-2419: были creator'ы, но все отсеялись safety-фильтром —
    // отдельный reason для счётчика индексера.
    if (creatorCandidates.length > 0 && safeCandidates.length === 0) {
      return {
        valid: false,
        reason: 'unsafe-attacker',
      };
    }
    return {
      valid: false,
      reason: `expected exactly 1 undefended-attacking move, found ${safeCandidates.length}`,
    };
  }

  const answer: AnswerMove = {
    shape: 'move',
    from: safeCandidates[0].from,
    to: safeCandidates[0].to,
  };
  return { valid: true, answer };
}
