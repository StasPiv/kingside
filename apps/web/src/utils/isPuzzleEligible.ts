/**
 * KS-3642 / ADR-106 §2.6. Pure-функция фильтра Precision-пазлов по
 * `maiaWeakChoiceProb`. Не привязана к фрейму UI — вызывается из
 * retry-логики подбора следующего пазла.
 *
 * Семантика **инвертирована** относительно отменённой ADR-104.
 * Высокая `maiaWeakChoiceProb` = пазл, на котором игрок с большой
 * вероятностью сыграет один из слабых ходов — это «хороший» пазл,
 * его оставляем.
 *
 * Правила (в порядке проверки):
 *   - `maiaWeakChoiceProb` `null` / `undefined` / не-конечное число →
 *     `true` (safe fallback): пазл ещё не размечен, пускаем в выдачу.
 *   - `maiaMetricVersion` отсутствует или не совпадает с текущей
 *     `MAIA_METRIC_VERSION` → `true` (значение от устаревшего алгоритма,
 *     семантически непригодно — относимся как к «не размечен»).
 *   - `maiaWeakChoiceProb >= threshold` → `true` (Maia вероятно ошибётся).
 *   - иначе → `false`.
 */
import { MAIA_METRIC_VERSION } from '../config/precisionMaiaThreshold';

export interface PuzzleEligibilityFields {
  /** Из `PuzzleDto.maiaWeakChoiceProb`. ADR-106 §2.5. */
  maiaWeakChoiceProb?: number | null;
  /** Из `PuzzleDto.maiaMetricVersion`. ADR-106 §2.5. */
  maiaMetricVersion?: number | null;
}

export function isPuzzleEligible(
  puzzle: PuzzleEligibilityFields,
  threshold: number,
): boolean {
  const p = puzzle.maiaWeakChoiceProb;
  if (p == null) return true;
  if (!Number.isFinite(p)) return true;
  // Версия метрики должна совпадать с текущей. Любое расхождение
  // (старая разметка или отсутствует) — пазл считается «не размечен».
  if (puzzle.maiaMetricVersion !== MAIA_METRIC_VERSION) return true;
  return p >= threshold;
}
