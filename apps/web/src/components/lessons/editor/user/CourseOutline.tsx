import { Fragment, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  UserLessonDto,
  UserLessonStepDto,
  UserStepType,
} from '@kingside/shared';

import {
  ReorderableList,
  SortableItem,
  type SortableHandleBag,
} from './dnd/ReorderableList';

/**
 * `CourseOutline` — sidebar-дерево курса
 * (KS-1848 §3.2, KS-1854 / FE-R6, FE-R13 KS-1861).
 *
 * Слева от основного контента: список уроков, активный подсвечен,
 * внутри активного видны шаги с якорными ссылками. Drag-handles ⠿
 * для перестановки уроков работают мышью / пальцем / клавиатурой
 * (см. `dnd/ReorderableList`).
 *
 * Компонент — чисто презентационный. Родитель передаёт:
 *  - `lessons` — список уроков (сортированный по order)
 *  - `activeLessonId` — какой урок сейчас активен в main-pane
 *  - `stepsByLesson` — кеш шагов (родитель подгружает при expand)
 *  - `expandedLessonIds` — какие уроки раскрыты (показывают свои шаги)
 *  - колбэки: `onSelectLesson`, `onToggleLessonExpand`, `onAddLesson`,
 *    `onSelectStep`, `onReorderLessons`
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
  /**
   * FE-R13 (KS-1861): drag-and-drop reorder уроков через
   * `@dnd-kit/sortable` (touch + mouse + keyboard). Если не задан —
   * drag-handles `⠿` остаются статичными декоративными элементами.
   */
  onReorderLessons?: (orderedIds: string[]) => void;
  busy?: boolean;
  /**
   * Опциональный кастомный drag-handle. Если задан — `onReorderLessons`
   * игнорируется (родитель сам контролирует DnD-логику). Используется
   * в storybook-сценариях / специфичных layout'ах.
   */
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
  onReorderLessons,
  busy,
  renderLessonDragHandle,
}: CourseOutlineProps) {
  const { t } = useTranslation();
  const lessonIds = useMemo(() => lessons.map((l) => l.id), [lessons]);
  // dnd-kit включаем только если родитель явно подписался на reorder
  // и не предоставил кастомный handle (renderLessonDragHandle имеет
  // приоритет — это «escape-hatch» для специфичных layout'ов и для
  // старого FE-R6 теста).
  const dndEnabled = !!onReorderLessons && !renderLessonDragHandle;
  /**
   * KS-1861-FIX: внутри `<SortableItem>` любой tap на вложенный
   * интерактивный элемент (select-lesson, expand, step-button)
   * всплывает в TouchSensor dnd-kit'а и блокирует синтетический click
   * на mobile. dnd-kit подписывается через нативный addEventListener
   * — нужно остановить именно native bubbling.
   */
  const stopPointerPropagation = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.nativeEvent.stopPropagation();
  };

  /**
   * Render одной строки урока. Если `handle` передан — это
   * dnd-kit-обёртка (`<SortableItem>` пробрасывает наружу bag),
   * `containerRef` идёт на `<li>`, `handleRef`/`attributes`/`listeners`
   * — на drag-handle `<button>`. Если не передан — обычная статичная
   * строка (renderLessonDragHandle или дефолтный handle без DnD).
   */
  const renderLessonRow = (
    lesson: UserLessonDto,
    handle?: SortableHandleBag,
  ) => {
    const active = lesson.id === activeLessonId;
    const expanded = expandedLessonIds.has(lesson.id);
    const steps = stepsByLesson[lesson.id] ?? [];
    return (
      <li
        ref={handle?.containerRef}
        style={handle?.style}
        className={
          'course-outline__item' +
          (active ? ' course-outline__item--active' : '') +
          (handle?.isOver ? ' course-outline__item--dnd-over' : '') +
          (handle?.isDragging ? ' course-outline__item--dragging' : '')
        }
        data-testid={`course-outline-lesson-${lesson.id}`}
        data-active={active ? 'true' : 'false'}
        data-dnd-over={handle?.isOver ? 'true' : undefined}
        data-dnd-dragging={handle?.isDragging ? 'true' : undefined}
      >
        <div className="course-outline__row">
          {renderLessonDragHandle ? (
            renderLessonDragHandle(lesson)
          ) : handle ? (
            <button
              type="button"
              ref={handle.handleRef}
              className="course-outline__drag-handle"
              data-testid={`course-outline-drag-${lesson.id}`}
              aria-label={t('editor.moveUp', 'Move up')}
              {...handle.attributes}
              {...handle.listeners}
            >
              ⠿
            </button>
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
            onPointerDown={stopPointerPropagation}
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
            aria-label={t('lessons.editor.preview', 'Preview')}
            onClick={() => onToggleLessonExpand(lesson.id)}
            onPointerDown={stopPointerPropagation}
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
                  onPointerDown={stopPointerPropagation}
                >
                  <span
                    className="course-outline__step-icon"
                    aria-hidden="true"
                  >
                    {stepIcon(step.type)}
                  </span>
                  <span className="course-outline__step-order">
                    #{idx + 1}
                  </span>
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
  };

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
      ) : dndEnabled && onReorderLessons ? (
        <ReorderableList itemIds={lessonIds} onReorder={onReorderLessons}>
          <ul
            className="course-outline__list"
            data-testid="course-outline-list"
          >
            {lessons.map((lesson) => (
              <SortableItem key={lesson.id} id={lesson.id}>
                {(h) => renderLessonRow(lesson, h)}
              </SortableItem>
            ))}
          </ul>
        </ReorderableList>
      ) : (
        <ul
          className="course-outline__list"
          data-testid="course-outline-list"
        >
          {lessons.map((lesson) => (
            <Fragment key={lesson.id}>{renderLessonRow(lesson)}</Fragment>
          ))}
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
