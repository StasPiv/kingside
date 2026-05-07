import { useTranslation } from 'react-i18next';
import type { UserStepType } from '@kingside/shared';

/**
 * `StepTypePicker` — карточки-выбор типа шага для user-редактора
 * (KS-1848 §3.3, KS-1851 / FE-R3).
 *
 * Показывает 4 варианта (text / puzzle / endgame_drill / quiz) с
 * иконкой, локализованным названием и кратким описанием. Радиогруппой
 * — т.к. одновременно выбран ровно один тип. Стили/темы подкрутит
 * layout отдельно (L-R7); здесь — семантика + testid'ы.
 *
 * KS-2574: добавлен `quiz` после KS-2570 (shared union UserStepType
 * расширен) и KS-2573 (`<QuizStepEditor>` готов).
 *
 * API:
 *  - `value` — текущий выбранный тип (или `null`, если ничего не
 *    выбрано)
 *  - `onSelect(type)` — вызывается при клике на карточку
 *  - `disabled` — делает все карточки некликабельными (для
 *    during-submit состояний)
 */

interface StepTypePickerProps {
  value: UserStepType | null;
  onSelect: (type: UserStepType) => void;
  disabled?: boolean;
  /** Опц. testid-префикс для изоляции нескольких picker'ов на странице. */
  testIdPrefix?: string;
}

/**
 * Порядок и набор типов — единый источник истины для user-курсов
 * (ADR-026 §2.3 whitelist). Меняется только вместе с `UserStepType`
 * в shared и с валидацией BE-3.
 */
export const USER_STEP_TYPES: readonly UserStepType[] = [
  'text',
  'puzzle',
  'endgame_drill',
  'quiz',
];

const ICONS: Record<UserStepType, string> = {
  text: '📝',
  puzzle: '♟️',
  endgame_drill: '⚔️',
  quiz: '❓',
};

const I18N_KEY: Record<UserStepType, { title: string; description: string }> = {
  text: {
    title: 'lessons.my.stepType.text',
    description: 'lessons.my.stepType.textDescription',
  },
  puzzle: {
    title: 'lessons.my.stepType.puzzle',
    description: 'lessons.my.stepType.puzzleDescription',
  },
  endgame_drill: {
    title: 'lessons.my.stepType.endgameDrill',
    description: 'lessons.my.stepType.endgameDrillDescription',
  },
  quiz: {
    title: 'lessons.my.stepType.quiz',
    description: 'lessons.my.stepType.quizDescription',
  },
};

export function StepTypePicker({
  value,
  onSelect,
  disabled,
  testIdPrefix = 'step-type-picker',
}: StepTypePickerProps) {
  const { t } = useTranslation();
  return (
    <div
      className="step-type-picker"
      data-testid={testIdPrefix}
      role="radiogroup"
      aria-label={t('lessons.my.editor.addStepPicker.title', 'Add a step')}
    >
      {USER_STEP_TYPES.map((type) => {
        const selected = value === type;
        return (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            className={`step-type-picker__card${selected ? ' step-type-picker__card--selected' : ''}`}
            data-testid={`${testIdPrefix}-option-${type}`}
            data-selected={selected ? 'true' : 'false'}
            onClick={() => onSelect(type)}
          >
            <span
              className="step-type-picker__icon"
              aria-hidden="true"
            >
              {ICONS[type]}
            </span>
            <span className="step-type-picker__title">
              {t(I18N_KEY[type].title, type)}
            </span>
            <span className="step-type-picker__description">
              {t(I18N_KEY[type].description, '')}
            </span>
          </button>
        );
      })}
    </div>
  );
}
