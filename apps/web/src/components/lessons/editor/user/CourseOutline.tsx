import { useTranslation } from 'react-i18next';
import type {
  UserLessonDto,
  UserLessonStepDto,
  UserStepType,
} from '@kingside/shared';

/**
 * `CourseOutline` — sidebar-дерево курса
 * (KS-1848 §3.2, KS-1854 / FE-R6).
 *
 * Слева от основного контента: список уроков, активный подсвечен,
 * внутри активного видны шаги с якорными ссылками. Drag-handles ⠿
 * для перестановки уроков (dnd-интеграция — в FE-R8; здесь просто
 * рендерим handle с колбэком при использовании).
 *
 * Компонент — чисто презентационный. Родитель передаёт:
 *  - `lessons` — список уроков (сортированный по order)
 *  - `activeLessonId` — какой урок сейчас активен в main-pane
 *  - `stepsByLesson` — кеш шагов (родитель подгружает при expand)
 *  - `expandedLessonIds` — какие уроки раскрыты (показывают свои шаги)
 *  - колбэки: `onSelectLesson`, `onToggleLessonExpand`, `onAddLesson`,
 *    `onSelectStep`
 */

interface CourseOutlineProps {
  lessons: UserLessonDto[];
  activeLessonId: string | null;
  stepsByLesson: Record<string, UserLessonStepDto[]>;
  expandedLessonIds: ReadonlySet<string>;
  onSelectLesson: (lessonId: string) => void;
  onToggleLessonExpand: (lessonId: string) => void;
  onAddLesson: () => void;
  onSelectStep: (lessonId: string, stepId: string) => void;
  busy?: boolean;
  /** Опциональный drag-handle — для FE-R8 dnd. */
  renderLessonDragHandle?: (lesson: UserLessonDto) => React.ReactNode;
}

const STEP_ICONS: Record<UserStepType, string> = {
  text: '📝',
  puzzle: '♟️',
  endgame_drill: '⚔️',
};

function stepIcon(type: string): string {
  if (type === 'text' || type === 'puzzle' || type === 'endgame_drill') {
    return STEP_ICONS[type];
  }
  return '❓';
}

export function CourseOutline({
  lessons,
  activeLessonId,
  stepsByLesson,
  expandedLessonIds,
  onSelectLesson,
  onToggleLessonExpand,
  onAddLesson,
  onSelectStep,
  busy,
  renderLessonDragHandle,
}: CourseOutlineProps) {
  const { t } = useTranslation();
  return (
    <aside className="course-outline" data-testid="course-outline">
      <header className="course-outline__header">
        <h2 className="course-outline__title">
          {t('lessons.my.editor.lessonsTitle', 'Lessons')}
        </h2>
      </header>

      {lessons.length === 0 ? (
        <p
          className="course-outline__empty"
          data-testid="course-outline-empty"
        >
          {t('lessons.my.editor.lessonsEmpty', 'No lessons yet')}
        </p>
      ) : (
        <ul className="course-outline__list" data-testid="course-outline-list">
          {lessons.map((lesson) => {
            const active = lesson.id === activeLessonId;
            const expanded = expandedLessonIds.has(lesson.id);
            const steps = stepsByLesson[lesson.id] ?? [];
            return (
              <li
                key={lesson.id}
                className={`course-outline__item${active ? ' course-outline__item--active' : ''}`}
                data-testid={`course-outline-lesson-${lesson.id}`}
                data-active={active ? 'true' : 'false'}
              >
                <div className="course-outline__row">
                  {renderLessonDragHandle ? (
                    renderLessonDragHandle(lesson)
                  ) : (
                    <button
                      type="button"
                      className="course-outline__drag-handle"
                      data-testid={`course-outline-drag-${lesson.id}`}
                      aria-label={t('editor.moveUp', 'Move up')}
                    >
                      ⠿
                    </button>
                  )}
                  <button
                    type="button"
                    className="course-outline__lesson-btn"
                    data-testid={`course-outline-lesson-select-${lesson.id}`}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => onSelectLesson(lesson.id)}
                  >
                    <span className="course-outline__lesson-title">
                      {lesson.title}
                    </span>
                    <span
                      className="course-outline__lesson-count"
                      data-testid={`course-outline-lesson-stepcount-${lesson.id}`}
                    >
                      {t('lessons.stepCount', {
                        count: lesson.stepCount,
                        defaultValue: '{{count}} steps',
                      })}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="course-outline__expand"
                    data-testid={`course-outline-expand-${lesson.id}`}
                    aria-expanded={expanded}
                    aria-label={t('editor.preview', 'Preview')}
                    onClick={() => onToggleLessonExpand(lesson.id)}
                  >
                    {expanded ? '▾' : '▸'}
                  </button>
                </div>
                {expanded && (
                  <ul
                    className="course-outline__steps"
                    data-testid={`course-outline-steps-${lesson.id}`}
                  >
                    {steps.map((step, idx) => (
                      <li
                        key={step.id}
                        className="course-outline__step"
                        data-testid={`course-outline-step-${step.id}`}
                      >
                        <button
                          type="button"
                          onClick={() => onSelectStep(lesson.id, step.id)}
                        >
                          <span className="course-outline__step-icon" aria-hidden="true">
                            {stepIcon(step.type)}
                          </span>
                          <span className="course-outline__step-order">#{idx + 1}</span>
                          <span className="course-outline__step-type">
                            {t(
                              `lessons.my.stepType.${step.type === 'endgame_drill' ? 'endgameDrill' : step.type}`,
                              step.type,
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                    {steps.length === 0 && (
                      <li
                        className="course-outline__step course-outline__step--empty"
                        data-testid={`course-outline-steps-empty-${lesson.id}`}
                      >
                        {t(
                          'lessons.my.editor.stepsEmpty.title',
                          'This lesson has no steps yet',
                        )}
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="course-outline__footer">
        <button
          type="button"
          className="course-outline__add-lesson"
          data-testid="course-outline-add-lesson"
          onClick={onAddLesson}
          disabled={busy}
        >
          {t('lessons.my.editor.addLesson', '+ Add lesson')}
        </button>
      </div>
    </aside>
  );
}
