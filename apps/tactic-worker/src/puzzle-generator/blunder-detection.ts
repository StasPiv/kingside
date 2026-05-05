/**
 * KS-2431 / ADR-041 §2.2-2.5. Blunder detection и отсев тривиальных
 * puzzle'ов.
 *
 * Выделено из generator-pipeline для отдельного юнит-тестирования
 * (без поднятия Chess-replay цикла).
 */
import type { Move } from 'chess.js';

/**
 * `evalDrop` — потеря для ходящей стороны на этом ходу:
 *   evalDrop = bestCpBefore - actualCpAfterFromSamePov
 *
 * Где:
 *   - bestCpBefore  — eval до хода, от лица ходящей стороны (best move).
 *   - actualCpAfter — eval после реально сделанного хода, от лица той
 *                     же ходящей стороны (она уже не на ходу).
 *
 * Положительное значение = ход был хуже best на это число cp.
 * Принимаем кандидата, если evalDrop ≥ minEvalDrop.
 */
export function isBlunder(
  evalDropCp: number,
  minEvalDropCp: number,
): boolean {
  return evalDropCp >= minEvalDropCp;
}

/**
 * Spread между лучшим и вторым ходом (uniqueness-фильтр).
 * spread ≥ minSpread → puzzle уникален в стартовой позиции.
 */
export function isUnique(spreadCp: number, minSpreadCp: number): boolean {
  return spreadCp >= minSpreadCp;
}

/**
 * Recapture-trash check (ADR-041 §2.5):
 *   - Если ход в партии (`madeMove`) был capture, а первый ход решения
 *     puzzle (`firstSolutionUci`) — тоже capture на той же клетке,
 *     это просто recapture после торгов, а не «настоящая» тактика.
 */
export function isRecapture(
  madeMove: Move,
  firstSolutionUci: string,
): boolean {
  if (firstSolutionUci.length < 4) return false;
  const solutionTo = firstSolutionUci.slice(2, 4);
  return Boolean(madeMove.captured) && madeMove.to === solutionTo;
}
