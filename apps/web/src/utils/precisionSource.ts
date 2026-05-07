/**
 * KS-2547 / ADR-048 §5. Helper для чтения query-параметра
 * `?source=...`, который используется как маркер прихода юзера на
 * `/puzzle/:id` из раздела «Тренировка точности» (`/precision`).
 *
 * Канонический value — `'precision'` (KS-2547). Старый `'play-vs-engine'`
 * остаётся как silent backward-compat — мы рассылали такие ссылки до
 * KS-2547. Любой downstream-код, читающий `source`, обязан принимать
 * оба значения, иначе старые ссылки начнут выглядеть как «обычный»
 * /puzzle/:id (теряем UX-контекст).
 *
 * Использование (псевдокод):
 *   const isFromPrecision = isPrecisionSource(searchParams.get('source'));
 */
export const PRECISION_SOURCE_VALUES = ['precision', 'play-vs-engine'] as const;
export type PrecisionSourceValue = (typeof PRECISION_SOURCE_VALUES)[number];

export function isPrecisionSource(
  source: string | null | undefined,
): source is PrecisionSourceValue {
  return (
    source === 'precision' || source === 'play-vs-engine'
  );
}
