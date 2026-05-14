/**
 * KS-2997 / ADR-065 §3.4. 5-балльная оценка решения precision-задачи.
 *
 * Чистая функция расчёта без side-effects. Используется:
 *  - сервером при создании `precision_attempts` (заполняет `score` /
 *    `scorePct` колонки, KS-2998 / B3 KS-2999);
 *  - бэкфилом legacy-attempt'ов (B5);
 *  - frontend'ом для предпросмотра (опционально, fallback на серверный).
 *
 * Алгоритм (ADR-065 §3.4):
 *
 *   1. Per-move accuracy → Lichess exponential formula:
 *      `103.1668 * exp(-0.04354 * loss_pct) - 3.1669`, clamp [0..100].
 *      Аргумент `loss_pct`:
 *        - Если есть `wdlBefore`/`wdlAfter`: `E = (w + d/2) / 1000`,
 *          `loss_pct = max(0, E_before - E_after) * 100` (ADR §2.1-2.3).
 *        - Если есть `cpBefore`/`cpAfter`: Lichess CP→Win формула
 *          `50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)` (§2.4.1).
 *        - Иначе fallback по classification (§2.4.2).
 *   2. Worst classification определяется по всем ходам с
 *      непустой `classification` (best < good < inaccuracy < mistake <
 *      blunder).
 *   3. Композит: `score_pct = 0.7 * mean(acc) + 0.3 * min(acc)`
 *      (§3.1, веса именованные для калибровки A1).
 *   4. Worst-class cap (§3.3): blunder → ≤ 60, mistake → ≤ 80.
 *   5. Star-mapping (§4): 95+ → 5★, 85+ → 4★, 70+ → 3★, 50+ → 2★, иначе 1★.
 *
 * Спец-кейсы (§3.4):
 *  - `moves.length < 2` → `{stars: null, scorePct: null}` (слишком
 *    короткая попытка).
 *  - data-points < 50% от moves → `null` (>50% gaps).
 *
 * Контрольные кейсы — `precision-score.test.ts`, 9 синтетических
 * сценариев из §4.3 + edge cases.
 */
import type { Wdl } from './wdl.js';

/** Классификация одного полухода (ADR-056 §2.5). */
export type PrecisionMoveClass =
  | 'best'
  | 'good'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder';

/**
 * Минимальный набор данных одного user-полухода для расчёта score.
 * Совместим с `PrecisionMoveDto` из `api-contracts.ts` (все поля —
 * подмножество). Все поля кроме `classification` опциональны: если
 * нет WDL и нет cp, classification используется как fallback.
 */
export interface PrecisionMoveInput {
  wdlBefore?: Wdl | null;
  wdlAfter?: Wdl | null;
  cpBefore?: number | null;
  cpAfter?: number | null;
  classification?: PrecisionMoveClass | null;
}

export interface PrecisionScoreResult {
  /** 1..5 stars; `null` если данных недостаточно (§3.4). */
  stars: 1 | 2 | 3 | 4 | 5 | null;
  /** 0..100 score_pct до округления до звёзд; `null` синхронно со stars. */
  scorePct: number | null;
}

// ─── Калибровочные константы (ADR-065 §3, §4) ─────────────────────
//
// Хранятся как именованные константы по двум причинам (риск #1, #2):
//  - этап 5 (A1) может скорректировать веса/пороги по реальным данным;
//  - изменение одной строки + бэкфил даёт новую калибровку без миграций.

/** ADR-065 §4: границы scorePct для каждой звезды (нижняя включительно). */
export const STAR_THRESHOLDS = {
  five: 95,
  four: 85,
  three: 70,
  two: 50,
} as const;

/** ADR-065 §3.1: веса композита mean+min. Сумма = 1.0. */
export const COMPOSITE_MEAN_WEIGHT = 0.7;
export const COMPOSITE_MIN_WEIGHT = 0.3;

/** ADR-065 §3.3: hard cap по worst-classification. */
export const WORST_CLASS_CAP: Record<'blunder' | 'mistake', number> = {
  blunder: 60,
  mistake: 80,
};

/**
 * ADR-065 §2.4.2: fallback accuracy по classification, когда нет ни
 * WDL, ни cp. Числа подобраны так, чтобы при стандартных диапазонах
 * cpLoss exp-formula давала похожий результат (см. ADR §2.4.2).
 */
export const CLASSIFICATION_FALLBACK_ACCURACY: Record<
  PrecisionMoveClass,
  number
> = {
  best: 95,
  good: 80,
  inaccuracy: 55,
  mistake: 25,
  blunder: 5,
};

/** ADR-065 §3.2: минимум полуходов для расчёта score. */
export const MIN_HALF_MOVES_FOR_SCORE = 2;

/**
 * ADR-065 §3.4: минимальная доля ходов с реальными данными
 * (WDL/cp/classification) — иначе score=null. >50% gaps.
 */
export const MIN_DATA_FRACTION = 0.5;

// ─── Lichess accuracy formula (ADR §2.3, §2.4.1) ──────────────────

/** Lichess accuracy константы: `103.1668 * exp(-0.04354 * loss) - 3.1669`. */
const ACC_A = 103.1668;
const ACC_B = -0.04354;
const ACC_C = -3.1669;

/** Lichess CP→Win константа: `2 / (1 + exp(-0.00368208 * cp))`. */
const CP_TO_WIN_K = -0.00368208;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Lichess CP→Win% (§2.4.1). cp ∈ ℝ (signed, POV игрока), результат
 * ∈ [0, 100]. Используется для legacy-attempt'ов без WDL.
 */
export function winPctFromCp(cp: number): number {
  if (!Number.isFinite(cp)) return 50;
  const raw = 50 + 50 * (2 / (1 + Math.exp(CP_TO_WIN_K * cp)) - 1);
  return clamp(raw, 0, 100);
}

/**
 * Per-move accuracy в [0..100] (Lichess formula, §2.3). Возвращает
 * `null` если данных нет вообще (`wdl=null && cp=null && classification=null`).
 *
 * Источники (в порядке приоритета):
 *  1. wdlBefore + wdlAfter → expected-score `E = (w + d/2) / 1000`,
 *     loss = max(0, E_before - E_after) * 100.
 *  2. cpBefore + cpAfter → Lichess CP→Win%.
 *  3. classification → таблица §2.4.2.
 */
export function accuracyMove(move: PrecisionMoveInput): number | null {
  if (move.wdlBefore && move.wdlAfter) {
    const eBefore =
      (move.wdlBefore.w + move.wdlBefore.d / 2) / 1000;
    const eAfter = (move.wdlAfter.w + move.wdlAfter.d / 2) / 1000;
    const lossPct = Math.max(0, eBefore - eAfter) * 100;
    return clamp(ACC_A * Math.exp(ACC_B * lossPct) + ACC_C, 0, 100);
  }
  if (typeof move.cpBefore === 'number' && typeof move.cpAfter === 'number') {
    const winBefore = winPctFromCp(move.cpBefore);
    const winAfter = winPctFromCp(move.cpAfter);
    const lossPct = Math.max(0, winBefore - winAfter);
    return clamp(ACC_A * Math.exp(ACC_B * lossPct) + ACC_C, 0, 100);
  }
  if (move.classification) {
    return CLASSIFICATION_FALLBACK_ACCURACY[move.classification];
  }
  return null;
}

/**
 * Worst classification среди ходов. `null` если ни у одного хода нет
 * classification. Порядок: best < good < inaccuracy < mistake < blunder.
 */
const CLASS_ORDER: readonly PrecisionMoveClass[] = [
  'best',
  'good',
  'inaccuracy',
  'mistake',
  'blunder',
] as const;

export function worstClassification(
  moves: PrecisionMoveInput[],
): PrecisionMoveClass | null {
  let worstIdx = -1;
  for (const m of moves) {
    if (!m.classification) continue;
    const idx = CLASS_ORDER.indexOf(m.classification);
    if (idx > worstIdx) worstIdx = idx;
  }
  return worstIdx >= 0 ? CLASS_ORDER[worstIdx] : null;
}

/**
 * scorePct → 1..5 звёзд (§4). Нижняя граница включительно: 95.0 → 5★,
 * 94.99 → 4★. Эффект «cliff» намеренный (риск #11).
 */
export function mapToStars(scorePct: number): 1 | 2 | 3 | 4 | 5 {
  if (scorePct >= STAR_THRESHOLDS.five) return 5;
  if (scorePct >= STAR_THRESHOLDS.four) return 4;
  if (scorePct >= STAR_THRESHOLDS.three) return 3;
  if (scorePct >= STAR_THRESHOLDS.two) return 2;
  return 1;
}

/**
 * Aggregate готовых accuracies в финальный score. Вынесено отдельно
 * для прямой проверки контрольных кейсов §4.3 (без построения wdl-
 * входов). Применяет композит mean+min и worst-class cap.
 *
 * `accuracies` — список значений в [0..100]; ≥1 элемент.
 * `worst` — worst-classification из исходных ходов; используется
 * только для cap'а (`null` ⇒ cap не применяется).
 */
export function aggregateAccuracies(
  accuracies: number[],
  worst: PrecisionMoveClass | null,
): PrecisionScoreResult {
  if (accuracies.length === 0) return { stars: null, scorePct: null };
  const mean =
    accuracies.reduce((acc, v) => acc + v, 0) / accuracies.length;
  let min = accuracies[0];
  for (let i = 1; i < accuracies.length; i++) {
    if (accuracies[i] < min) min = accuracies[i];
  }
  let scorePct =
    COMPOSITE_MEAN_WEIGHT * mean + COMPOSITE_MIN_WEIGHT * min;
  if (worst === 'blunder') {
    scorePct = Math.min(scorePct, WORST_CLASS_CAP.blunder);
  } else if (worst === 'mistake') {
    scorePct = Math.min(scorePct, WORST_CLASS_CAP.mistake);
  }
  return { stars: mapToStars(scorePct), scorePct };
}

/**
 * KS-2997 / ADR-065 §3.4. Главная функция: вход — массив user-полуходов
 * (минимальный набор полей `PrecisionMoveInput`), выход — `{stars, scorePct}`.
 *
 * Чистая (без side-effects, без I/O, deterministic), легко тестируется.
 *
 * Возвращает `{stars: null, scorePct: null}` если:
 *  - `moves.length < MIN_HALF_MOVES_FOR_SCORE` (§3.2);
 *  - менее `MIN_DATA_FRACTION` ходов имеют данные для расчёта (§3.4
 *    «>50% gaps» case).
 */
export function computePrecisionScore(
  moves: PrecisionMoveInput[],
): PrecisionScoreResult {
  if (moves.length < MIN_HALF_MOVES_FOR_SCORE) {
    return { stars: null, scorePct: null };
  }
  const accuracies: number[] = [];
  for (const m of moves) {
    const a = accuracyMove(m);
    if (a !== null) accuracies.push(a);
  }
  if (accuracies.length < moves.length * MIN_DATA_FRACTION) {
    return { stars: null, scorePct: null };
  }
  return aggregateAccuracies(accuracies, worstClassification(moves));
}
