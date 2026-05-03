/**
 * KS-2234 (ADR-035 §7.3, E3) — overlay поверх доски для визуального
 * feedback'а после ответа пользователя в drill'е.
 *
 * Кладётся в `<DrillBoard overlay={…}>` или иной контейнер с
 * `position: relative`. Полупрозрачная заливка (зелёная для `correct`,
 * красная для `incorrect`) с короткой анимацией fade-in. Сам overlay
 * `pointer-events: none` — не блокирует кликабельность доски (если хост
 * хочет принять следующий клик до закрытия feedback'а).
 *
 * `result === null` (или undefined) — компонент не рендерится; удобно
 * вешать в render-tree без условий.
 *
 * # Контракт DOM
 *
 *   <div class="drill-feedback drill-feedback--<correct|incorrect>"
 *        data-testid="drill-feedback"
 *        data-result="<correct|incorrect>"
 *        aria-live="polite"
 *        aria-label="Correct" | "Incorrect" />
 */
export type DrillFeedbackResult = 'correct' | 'incorrect';

export interface DrillFeedbackOverlayProps {
  result: DrillFeedbackResult | null | undefined;
  /** A11y label, по умолчанию — англоязычное «Correct»/«Incorrect». */
  label?: string;
}

export function DrillFeedbackOverlay({
  result,
  label,
}: DrillFeedbackOverlayProps) {
  if (!result) return null;
  const computedLabel =
    label ?? (result === 'correct' ? 'Correct' : 'Incorrect');
  return (
    <div
      className={`drill-feedback drill-feedback--${result}`}
      data-testid="drill-feedback"
      data-result={result}
      aria-live="polite"
      aria-label={computedLabel}
    />
  );
}
