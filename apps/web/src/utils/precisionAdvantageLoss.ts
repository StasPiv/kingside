/**
 * KS-3040: «Потери преимущества» — процент net drop в win-probability
 * от стартовой позиции к финальной.
 *
 * Формула: `clamp((wdlAtStart - wdlAtEnd) / 2, 0, 1) * 100`, округлено
 * до целого. WDL signed ∈ [-1..+1], значит максимально возможная
 * просадка (+1 → -1) равна 2 → нормируем делением на 2 и в %.
 *
 * Recovery (end > start) → 0%. Это сознательно: метрика «потерь»
 * не «вознаграждает» за восстановление; recovery видна в `accuracyPct`
 * и в score (звёзды).
 *
 * Раньше использовали `wdlLeakSum * 100` — сумма per-move drops без
 * клемпы. Для попыток с большими просадками сумма превышала 1.0 и
 * UI показывал «122%», что бессмысленно для процента.
 */
export function computeAdvantageLossPct(
  wdlAtStart: number,
  wdlAtEnd: number,
): number {
  const rawDrop = (wdlAtStart - wdlAtEnd) / 2;
  const clamped = Math.max(0, Math.min(1, rawDrop));
  return Math.round(clamped * 100);
}
