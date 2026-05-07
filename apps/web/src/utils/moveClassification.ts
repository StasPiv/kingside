/**
 * KS-2504 / ADR-047 §2.2 + §3 #1.
 *
 * Pure-функция классификации хода по cp-loss (Lichess-пороги).
 *
 *  - `isBest === true`  → `'best'` (ход совпал с лучшим по движку
 *    PV[0]; cp-loss ≈ 0 по построению, метка идёт мимо порогов).
 *  - cp-loss < 50       → `'good'`
 *  - 50  ≤ cp-loss < 100 → `'inaccuracy'`
 *  - 100 ≤ cp-loss < 200 → `'mistake'`
 *  - cp-loss ≥ 200      → `'blunder'`
 *
 * cp-loss = `cpBefore − cpAfter`, оба числа в одной системе отсчёта
 * (с точки зрения игрока, сделавшего ход). Отрицательный cp-loss
 * (позиция улучшилась) попадает в `'good'` — по правилу Lichess.
 *
 * Mate-оценки нормализует вызывающий (обычно ±100000 или ±10000).
 * Функция числа не урезает — гигантская положительная разница
 * корректно классифицируется как `'blunder'`.
 *
 * Pure, без React/SDK зависимостей. Переиспользуется Workshop'ом.
 */

export type MoveClass = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

export interface ClassifyMoveInput {
  /** Оценка позиции до хода (centipawns, с точки зрения сделавшего ход). */
  cpBefore: number;
  /** Оценка позиции после хода (та же система отсчёта). */
  cpAfter: number;
  /** true, если ход совпал с лучшим по движку (engine PV[0]). */
  isBest: boolean;
}

export function classifyMove({
  cpBefore,
  cpAfter,
  isBest,
}: ClassifyMoveInput): MoveClass {
  if (isBest) return 'best';
  const cpLoss = cpBefore - cpAfter;
  if (cpLoss < 50) return 'good';
  if (cpLoss < 100) return 'inaccuracy';
  if (cpLoss < 200) return 'mistake';
  return 'blunder';
}
