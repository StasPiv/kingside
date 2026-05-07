/**
 * KS-2227 / KS-2399 / KS-2400 / KS-2406 / KS-2408 / KS-2455 — `find-fork`.
 *
 * Семантика (после миграции на shape='move'): «найти ход стороны на
 * ходу, который **создаёт новую** вилку — фигуру нашего цвета,
 * атакующую ≥2 ценных фигур противника одновременно». Ответ —
 * `{shape:'move', from, to}`.
 *
 * Эволюция определения «новизны»:
 *   - KS-2400: snapshot множества **клеток-форкеров** до/после хода.
 *   - KS-2408: сравниваем **множества целей** конкретного форкера
 *     до и после хода. Условие новой вилки:
 *       1) у форкера в attacksAfter ≥ 2 ценных целей;
 *       2) ни одна из этих целей не входит в множество того, что
 *          **тот же форкер** атаковал до хода (intersection = ∅).
 *     Для ходящей фигуры old-square = m.from; для discovered-форкера
 *     — его собственная клетка.
 *   - KS-2406: дополнительный safety-check форкера: если на клетке
 *     форкера после хода есть прямой enemy-attacker → drop.
 *
 * KS-2455: вычисление overlap-фильтра вынесено в чистый helper
 * `computeForkAnalysisAfterMove` из `@kingside/shared/chess/fork`,
 * который возвращает clean-форкера и флаг `hasOverlap`. Predicate
 * остаётся только обёрткой с safety-check'ом и strict-uniqueness'ом.
 *
 * Reason'ы при drop:
 *   - `'invalid_fen'` — FEN не парсится.
 *   - `'unsafe-forker'` — был хотя бы 1 clean fork-creator, но все
 *     отсеялись safety-фильтром. KS-2406.
 *   - `'overlap-with-previous-attacks'` — clean fork-creator'ов нет,
 *     но был хотя бы 1 ход, который дал бы fork с пересекающимися
 *     целями. KS-2408.
 *   - `'expected exactly 1 …'` — общее «не нашли / не уникально».
 */

import type { AnswerMove } from '@kingside/shared';
import { computeForkAnalysisAfterMove } from '@kingside/shared';
import { oppColor, tryLoadChess, type MoveResult } from './types';

export function findFork(fen: string): MoveResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const enemy = oppColor(chess.turn());

  // KS-2408 буфера для отчётности:
  //   cleanCandidates — ходы, прошедшие overlap-фильтр.
  //   safeCandidates — cleanCandidates ∩ safe (KS-2406).
  //   overlapBlockedCount — ходы, у которых был форкер с targets≥2 и
  //     overlap'ом, но clean форкера не нашлось — для reason
  //     'overlap-with-previous-attacks', если clean пуст.
  const cleanCandidates: { from: string; to: string }[] = [];
  const safeCandidates: { from: string; to: string }[] = [];
  let overlapBlockedCount = 0;

  for (const m of chess.moves({ verbose: true })) {
    if (m.promotion) continue;

    // KS-2455: helper делает apply+undo внутри, FEN передаётся свежий
    // на каждой итерации. Это чуть дороже, чем in-place apply/undo на
    // одном инстансе, но переиспользует pure-функцию shared.
    const analysis = computeForkAnalysisAfterMove(chess.fen(), {
      from: m.from,
      to: m.to,
    });

    if (analysis.clean) {
      cleanCandidates.push({ from: m.from, to: m.to });
      // KS-2406 safety: проверяем после apply m, есть ли enemy-attacker
      // на m.to. Делаем locally, не доверяя undo внутри helper'а.
      chess.move({ from: m.from, to: m.to });
      const enemyAttackers = chess.attackers(m.to, enemy);
      chess.undo();
      if (enemyAttackers.length === 0) {
        safeCandidates.push({ from: m.from, to: m.to });
      }
    } else if (analysis.hasOverlap) {
      overlapBlockedCount += 1;
    }
  }

  if (safeCandidates.length !== 1) {
    if (cleanCandidates.length === 0 && overlapBlockedCount > 0) {
      return {
        valid: false,
        reason: 'overlap-with-previous-attacks',
      };
    }
    if (cleanCandidates.length > 0 && safeCandidates.length === 0) {
      return {
        valid: false,
        reason: 'unsafe-forker',
      };
    }
    return {
      valid: false,
      reason: `expected exactly 1 fork-creating move, found ${safeCandidates.length}`,
    };
  }

  const answer: AnswerMove = {
    shape: 'move',
    from: safeCandidates[0].from,
    to: safeCandidates[0].to,
  };
  return { valid: true, answer };
}
