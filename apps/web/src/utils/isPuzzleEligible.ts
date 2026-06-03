/**
 * KS-3634 / ADR-104 §8. Pure-функция фильтра Precision-пазлов по
 * `maiaTop1Prob`. Не привязана к фрейму UI — вызывается из retry-логики
 * подбора следующего пазла.
 *
 *   - `null`/`undefined` → `true` (safe fallback): на время бэкфилла
 *     неразмеченные пазлы продолжают попадать в выдачу.
 *   - `prob <= threshold` → `true` (Maia не уверена в ходе → пазл
 *     достаточно нетривиален).
 *   - `prob > threshold` → `false`.
 */

export interface PuzzleEligibilityFields {
  /** Из `PuzzleDto.maiaTop1Prob`. ADR-104 §4. */
  maiaTop1Prob?: number | null;
}

export function isPuzzleEligible(
  puzzle: PuzzleEligibilityFields,
  threshold: number,
): boolean {
  const p = puzzle.maiaTop1Prob;
  if (p == null) return true;
  if (!Number.isFinite(p)) return true;
  return p <= threshold;
}
