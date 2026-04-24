import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UserStepType } from '@kingside/shared';

import { StepTypePicker } from './StepTypePicker';

/**
 * `AddStepEmptyState` — онбординговая карточка для пустого списка
 * шагов в user-редакторе (KS-1848 §3.7, KS-1851 / FE-R3).
 *
 * UX: заголовок («В уроке ещё нет шагов») + подпись + `StepTypePicker`
 * + «Добавить первый шаг»-CTA, которая становится активной только
 * после выбора типа. По клику — вызывает `onAdd(type)`.
 *
 * API:
 *  - `onAdd(type)` — добавить первый шаг выбранного типа
 *  - `busy` — во время запроса блокирует CTA и picker
 */

interface AddStepEmptyStateProps {
  onAdd: (type: UserStepType) => void;
  busy?: boolean;
}

export function AddStepEmptyState({ onAdd, busy }: AddStepEmptyStateProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<UserStepType | null>(null);
  const canAdd = selected !== null && !busy;

  return (
    <div
      className="editor-empty-state editor-empty-state--steps"
      data-testid="add-step-empty-state"
    >
      <h3 className="editor-empty-state__title">
        {t('lessons.my.editor.stepsEmpty.title', 'This lesson has no steps yet')}
      </h3>
      <p className="editor-empty-state__subtitle">
        {t(
          'lessons.my.editor.stepsEmpty.subtitle',
          'Add the first step — your learner starts from here.',
        )}
      </p>
      <StepTypePicker
        value={selected}
        onSelect={setSelected}
        disabled={busy}
        testIdPrefix="add-step-empty-picker"
      />
      <button
        type="button"
        className="editor-empty-state__cta"
        disabled={!canAdd}
        onClick={() => {
          if (selected) onAdd(selected);
        }}
        data-testid="add-step-empty-cta"
      >
        {t('lessons.my.editor.stepsEmpty.cta', 'Add the first step')}
      </button>
    </div>
  );
}
