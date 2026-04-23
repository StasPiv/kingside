import { useTranslation } from 'react-i18next';
import type { LessonStep } from '@kingside/shared';

import { TextStep } from './steps/TextStep';
import { PuzzleStep } from './steps/PuzzleStep';
import { QuizStep } from './steps/QuizStep';

/**
 * Диспетчер рендера шагов урока (L-08).
 *
 * Сужает дискриминированный union `step.payload.type` и делегирует
 * рендер конкретному компоненту. В MVP реализован `text` — остальные
 * типы (`puzzle`, `quiz`, `position`, `game_review`, `video`)
 * рендерят stub «coming soon» и появятся в L-09 / L-10 / итерациях 2-3.
 *
 * Колбэк `onStepDone` пробрасывается в child-компоненты для отметки
 * прохождения шага. Реальная привязка к `useLessonProgress` — задача
 * L-11 (KS-1766); сейчас `LessonPage` передаёт no-op.
 */

export interface StepRendererProps {
  step: LessonStep;
  onStepDone?: () => void;
  /** Скрыть кнопку «Далее» (последний шаг → действие «Завершить урок»). */
  hideNext?: boolean;
}

export function StepRenderer({ step, onStepDone, hideNext }: StepRendererProps) {
  const { t } = useTranslation();
  const { payload } = step;

  switch (payload.type) {
    case 'text':
      return (
        <TextStep payload={payload} onStepDone={onStepDone} hideNext={hideNext} />
      );

    case 'puzzle':
      return (
        <PuzzleStep payload={payload} onStepDone={onStepDone} hideNext={hideNext} />
      );

    case 'quiz':
      return (
        <QuizStep payload={payload} onStepDone={onStepDone} hideNext={hideNext} />
      );

    case 'position':
    case 'game_review':
    case 'video':
      return (
        <div
          className={`lesson-step-stub lesson-step-stub--${payload.type}`}
          data-testid={`lesson-step-stub-${payload.type}`}
        >
          <p>
            {t('lessons.stepNotImplemented', {
              type: t(`lessons.stepType.${payload.type}`, payload.type),
              defaultValue: '“{{type}}” steps will be available soon',
            })}
          </p>
          {!hideNext && (
            <button
              type="button"
              className="lesson-step-stub__next"
              data-testid="lesson-step-stub-next"
              onClick={() => onStepDone?.()}
            >
              {t('lessons.skip', 'Skip')}
            </button>
          )}
        </div>
      );

    default: {
      // exhaustive-check: новый тип шага должен быть добавлен явно.
      const _exhaustive: never = payload;
      void _exhaustive;
      return (
        <div
          className="lesson-step-stub lesson-step-stub--unknown"
          data-testid="lesson-step-stub-unknown"
        >
          <p>{t('lessons.stepUnknown', 'Unknown step type')}</p>
        </div>
      );
    }
  }
}
