/**
 * KS-2227 / KS-2372 / KS-2419 / KS-2455 — `find-undefended-attack`.
 *
 * Семантика: «найти ход стороны на ходу, который **создаёт** новую
 * угрозу взятия незащищённой фигуры противника». Угроза должна быть
 * **новой** — то есть не существовать в позиции ДО хода. Если фигура
 * противника уже была без защитников и под боем — это пассивная
 * висящая, не «создание угрозы».
 *
 * KS-2419 — safety-check атакующей фигуры: если на клетке `m.to`
 * после хода есть хоть один прямой enemy-attacker — кандидат
 * отбрасывается. Простая v1, без SEE.
 *
 * KS-2455: вычисление newThreats вынесено в чистый helper
 * `computeNewThreatsAfterMove` из `@kingside/shared/chess/undefended-
 * attack`. Predicate остаётся только обёрткой с safety-check'ом и
 * strict-uniqueness'ом.
 *
 * Reason'ы при drop:
 *   - `'invalid_fen'` — FEN не парсится.
 *   - `'unsafe-attacker'` — был ровно 1 creator-кандидат, отсеялся
 *     safety-фильтром.
 *   - `'expected exactly 1 …'` — общее.
 */

import type { AnswerMove } from '@kingside/shared';
import { computeNewThreatsAfterMove } from '@kingside/shared';
import { oppColor, tryLoadChess, type MoveResult } from './types';

export function findUndefendedAttack(fen: string): MoveResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const enemy = oppColor(chess.turn());

  // KS-2419 буфера для отчётности:
  //   creatorCandidates — ходы, создающие новую угрозу.
  //   safeCandidates — creatorCandidates ∩ safe.
  const creatorCandidates: { from: string; to: string }[] = [];
  const safeCandidates: { from: string; to: string }[] = [];

  for (const m of chess.moves({ verbose: true })) {
    // promotion — отбрасываем (v1 не поддерживает).
    if (m.promotion) continue;

    // KS-2455: helper отдаёт массив новых угроз (под боем + без
    // защитников + не было таких до хода).
    const { newThreats } = computeNewThreatsAfterMove(chess.fen(), {
      from: m.from,
      to: m.to,
    });
    if (newThreats.length === 0) continue;

    creatorCandidates.push({ from: m.from, to: m.to });

    // KS-2419 safety-check: применяем ход локально, проверяем
    // enemy-attacker'ов на m.to.
    chess.move({ from: m.from, to: m.to });
    const enemyAttackers = chess.attackers(m.to, enemy);
    chess.undo();
    if (enemyAttackers.length === 0) {
      safeCandidates.push({ from: m.from, to: m.to });
    }
  }

  if (safeCandidates.length !== 1) {
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
