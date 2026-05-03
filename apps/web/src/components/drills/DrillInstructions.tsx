import type { ReactNode } from 'react';

/**
 * KS-2234 (ADR-035 §7.3, E3) — плашка с короткой инструкцией для drill'а.
 *
 * Показывается над/под доской. Поддерживает три тона:
 *  - `info` (default) — нейтральный, при первой загрузке drill'а.
 *  - `success` — после правильного ответа («Верно! …»).
 *  - `error` — после неправильного ответа («Неверно. Правильный ответ — …»).
 *
 * # Контракт DOM
 *
 *   <div class="drill-instructions drill-instructions--<tone>"
 *        data-testid="drill-instructions"
 *        data-tone="<tone>"
 *        role="status">
 *     {children — текст или ReactNode}
 *   </div>
 *
 * `role="status"` — для скринридеров: при смене содержимого озвучивается
 * (live-region polite). Подходит для feedback-сообщений.
 */
export type DrillInstructionsTone = 'info' | 'success' | 'error';

export interface DrillInstructionsProps {
  children: ReactNode;
  tone?: DrillInstructionsTone;
}

export function DrillInstructions({
  children,
  tone = 'info',
}: DrillInstructionsProps) {
  return (
    <div
      className={`drill-instructions drill-instructions--${tone}`}
      data-testid="drill-instructions"
      data-tone={tone}
      role="status"
    >
      {children}
    </div>
  );
}
