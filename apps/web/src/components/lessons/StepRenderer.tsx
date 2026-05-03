import { useTranslation } from 'react-i18next';
import type { LessonStep, LessonStepState } from '@kingside/shared';

import { TextStep } from './steps/TextStep';
import { PuzzleStep } from './steps/PuzzleStep';
import { QuizStep } from './steps/QuizStep';
import { PositionStep } from './steps/PositionStep';
import { VideoStep } from './steps/VideoStep';
import { GameReviewStep } from './steps/GameReviewStep';
import { EndgameDrillStep } from './steps/EndgameDrillStep';
import { OpeningDrillStep } from './steps/OpeningDrillStep';
// KS-2249: drill-step (tactic drill встраивается в lesson).
import { DrillStep } from './steps/DrillStep';

/**
 * Диспетчер рендера шагов урока (L-08).
 *
 * Сужает дискриминированный union `step.payload.type` и делегирует
 * рендер конкретному компоненту. Реализованы все 6 типов: `text`,
 * `puzzle`, `quiz`, `position`, `video`, `game_review`.
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
  /**
   * Текущее состояние шага из `useUserLessonProgress.stepsState`
   * (KS-1891). Используется для визуального отличия done-шага от
   * pending — TextStep показывает «Пройдено ✓» вместо «Далее».
   * Для интерактивных шагов (puzzle/endgame_drill) пока не
   * пробрасывается дальше — у них своя кнопка после решения.
   */
  stepState?: LessonStepState;
}

export function StepRenderer({ step, onStepDone, hideNext, stepState }: StepRendererProps) {
  const { t } = useTranslation();
  const { payload } = step;

  switch (payload.type) {
    case 'text':
      return (
        <TextStep
          payload={payload}
          onStepDone={onStepDone}
          hideNext={hideNext}
          stepState={stepState}
        />
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
      return (
        <PositionStep payload={payload} onStepDone={onStepDone} hideNext={hideNext} />
      );

    case 'video':
      return (
        <VideoStep payload={payload} onStepDone={onStepDone} hideNext={hideNext} />
      );

    case 'game_review':
      return (
        <GameReviewStep
          payload={payload}
          onStepDone={onStepDone}
          hideNext={hideNext}
        />
      );

    case 'endgame_drill':
      return (
        <EndgameDrillStep
          payload={payload}
          onStepDone={onStepDone}
          hideNext={hideNext}
        />
      );

    case 'opening_drill':
      return (
        <OpeningDrillStep
          payload={payload}
          onStepDone={onStepDone}
          hideNext={hideNext}
        />
      );

    case 'drill':
      // KS-2249: tactic drill (count-attackers / find-pin / ...).
      return (
        <DrillStep
          payload={payload}
          onStepDone={onStepDone}
          stepId={step.id}
          hideNext={hideNext}
        />
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
