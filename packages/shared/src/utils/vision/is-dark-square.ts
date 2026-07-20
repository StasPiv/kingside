/**
 * KS-4981 / ADR-167 §1, §4: цвет клетки шахматной доски.
 *
 * Правило: `a=1..h=8`; сумма номера файла и ранга. Чётная → тёмная,
 * нечётная → светлая. Проверочные точки: `a1` тёмная, `h1` светлая.
 *
 * В координатах `parseSquare` (0-индексных) сумма `(file+rank)` 1-индексных
 * имеет ту же чётность, что и `(f+r)` — поэтому `(f+r)%2===0 ⇒ тёмная`.
 */
import type { BlindBoardSquare } from '../../types/api-contracts.js';
import type { VisionSquareColor } from '../../types/vision.js';
import { parseSquare } from '../blind-board/move-gen.js';

/** `true`, если клетка тёмная (ADR-167 §1). */
export function isDarkSquare(sq: BlindBoardSquare): boolean {
  const [f, r] = parseSquare(sq);
  return (f + r) % 2 === 0;
}

/** Цвет клетки как строковый литерал. */
export function squareColor(sq: BlindBoardSquare): VisionSquareColor {
  return isDarkSquare(sq) ? 'dark' : 'light';
}
