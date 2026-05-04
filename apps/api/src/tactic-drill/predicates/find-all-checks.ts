/**
 * KS-2227 / ADR-035 §2.1 #2 — `find-all-checks`.
 *
 * Алгоритм: `chess.moves({verbose:true}).filter(m => m.san.includes('+'))`
 * → уникальные `to`-клетки.
 *
 * Инварианты (ADR §2.1 строка 2 + §2.2 + methodology §6.3):
 *  - 2 ≤ |unique to| ≤ 7. Меньше 2 — позиция не drill-задача
 *    (одиночный шах = тривиально), больше 7 — превышает контракт
 *    `AnswerSquares` (UI 7-кнопок).
 *  - Если среди check-ходов есть мат в один (`isCheckmate()` после
 *    хода) — drop. Семантически: позиция содержит forced-win, drill
 *    «найди все шахи» в ней дезориентирует — пользователь ждёт мат,
 *    а от него требуют список клеток. Историческое замечание: до
 *    KS-2393 пересечение было с типом `mate-in-1 (deprecated)`,
 *    сейчас тип удалён, но фильтр сохраняем как UX-инвариант.
 */

import type { AnswerSquares } from '@kingside/shared';
import { tryLoadChess, type SquaresResult } from './types';

const MIN_CHECKS = 2;
const MAX_CHECKS = 7;

export function findAllChecks(fen: string): SquaresResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const moves = chess.moves({ verbose: true });
  const checkSquares = new Set<string>();
  let hasMate = false;

  for (const m of moves) {
    if (!m.san.includes('+') && !m.san.includes('#')) continue;
    chess.move({ from: m.from, to: m.to, promotion: m.promotion });
    const isMate = chess.isCheckmate();
    chess.undo();
    if (isMate) hasMate = true;
    checkSquares.add(m.to);
  }

  if (hasMate) {
    return { valid: false, reason: 'position contains mate-in-one' };
  }
  if (checkSquares.size < MIN_CHECKS) {
    return {
      valid: false,
      reason: `expected ≥${MIN_CHECKS} checks, found ${checkSquares.size}`,
    };
  }
  if (checkSquares.size > MAX_CHECKS) {
    return {
      valid: false,
      reason: `expected ≤${MAX_CHECKS} checks, found ${checkSquares.size}`,
    };
  }

  // Нормализуем порядок (множество без порядка, но детерминизм upon
  // сериализации в БД полезен для дебага).
  const answer: AnswerSquares = {
    shape: 'squares',
    squares: Array.from(checkSquares).sort(),
  };
  return { valid: true, answer };
}
