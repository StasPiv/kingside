import { useTranslation } from 'react-i18next';

/**
 * `AddLessonEmptyState` — карточка для пустого курса
 * (KS-1848 §3.7, KS-1851 / FE-R3).
 *
 * UX: заголовок «У курса ещё нет уроков» + подпись + одна CTA-кнопка
 * «Добавить первый урок». Без type-picker'а (урок не имеет типа, в
 * отличие от шага — у него просто заголовок).
 */

interface AddLessonEmptyStateProps {
  onAdd: () => void;
  busy?: boolean;
}

export function AddLessonEmptyState({ onAdd, busy }: AddLessonEmptyStateProps) {
  const { t } = useTranslation();
  return (
    <div
      className="editor-empty-state editor-empty-state--lessons"
      data-testid="add-lesson-empty-state"
    >
      <h3 className="editor-empty-state__title">
        {t(
          'lessons.my.editor.lessonsEmptyState.title',
          'No lessons in this course yet',
        )}
      </h3>
      <p className="editor-empty-state__subtitle">
        {t(
          'lessons.my.editor.lessonsEmptyState.subtitle',
          'A course starts from a lesson. Add the first one — your learner will see it.',
        )}
      </p>
      <button
        type="button"
        className="editor-empty-state__cta"
        disabled={busy}
        onClick={onAdd}
        data-testid="add-lesson-empty-cta"
      >
        {t(
          'lessons.my.editor.lessonsEmptyState.cta',
          'Add the first lesson',
        )}
      </button>
    </div>
  );
}
