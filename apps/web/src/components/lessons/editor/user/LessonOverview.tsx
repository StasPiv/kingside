import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  StepPayload,
  UserLessonDto,
  UserLessonStepDto,
  UserStepType,
} from '@kingside/shared';

import type { AutoSaveStatus } from '../../../../hooks/useAutoSave';
import { AddStepEmptyState } from './AddStepEmptyState';
import { ReorderableList, SortableItem } from './dnd/ReorderableList';
import { StepCard } from './StepCard';
import { StepTypePicker } from './StepTypePicker';

/**
 * `LessonOverview` — main-контейнер редактора одного урока
 * (KS-1848 §3.2, KS-1853 / FE-R5). Собирает воедино:
 *
 *  - Заголовок урока: title + estMinutes (оба inline-редактируемые)
 *    + кнопка «Удалить урок»
 *  - Список `<StepCard>` (FE-R4) с reorder-кнопками ↑↓ (dnd добавит
 *    FE-R8 через слот `dragHandleProps`)
 *  - `<AddStepEmptyState>` если шагов нет; иначе CTA «+ Добавить шаг»
 *    с inline-picker'ом типа
 *
 * Компонент — чисто презентационный. Родитель передаёт данные, стейт
 * раскрытия аккордеонов и колбэки. Save-статусы по шагам приходят
 * через prop `stepSaveStatusById` (родитель держит `useAutoSave` на
 * шаг / курс и мапит статусы).
 */

interface LessonOverviewProps {
  lesson: UserLessonDto;
  steps: UserLessonStepDto[];
  /** Какие шаги раскрыты в аккордеоне. */
  expandedStepIds: ReadonlySet<string>;
  /** Save-статус на каждый шаг (по умолчанию idle). */
  stepSaveStatusById?: Record<string, AutoSaveStatus>;
  onTitleChange: (next: string) => void;
  onEstMinutesChange: (next: number | null) => void;
  onDeleteLesson: () => void;
  onToggleStepExpand: (stepId: string) => void;
  onStepPayloadChange: (stepId: string, payload: StepPayload) => void;
  onDeleteStep: (stepId: string) => void;
  onDuplicateStep: (stepId: string) => void;
  onAddStep: (type: UserStepType) => void;
  onMoveStep: (stepId: string, direction: -1 | 1) => void;
  /**
   * FE-R13 (KS-1861): drag-and-drop reorder через `@dnd-kit/sortable`
   * — работает мышью (PointerSensor), пальцем на iOS/Android
   * (TouchSensor с long-press 250ms) и клавиатурой (KeyboardSensor:
   * Tab → Space → ↑/↓ → Space, Esc — cancel). Если колбэк не задан —
   * drag-handles превращаются в no-op, кнопки ↑/↓ остаются как
   * accessibility-fallback.
   */
  onReorderSteps?: (orderedIds: string[]) => void;
  busy?: boolean;
}

export function LessonOverview({
  lesson,
  steps,
  expandedStepIds,
  stepSaveStatusById,
  onTitleChange,
  onEstMinutesChange,
  onDeleteLesson,
  onToggleStepExpand,
  onStepPayloadChange,
  onDeleteStep,
  onDuplicateStep,
  onAddStep,
  onMoveStep,
  onReorderSteps,
  busy,
}: LessonOverviewProps) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerType, setPickerType] = useState<UserStepType | null>(null);

  // FE-R13: список ID для SortableContext; пересчитываем только при
  // изменении набора шагов (а не при каждом ре-рендере родителя).
  const stepIds = useMemo(() => steps.map((s) => s.id), [steps]);
  const dndEnabled = !!onReorderSteps;

  const confirmAdd = () => {
    if (!pickerType) return;
    onAddStep(pickerType);
    setPickerOpen(false);
    setPickerType(null);
  };

  return (
    <div
      className="lesson-overview"
      data-testid={`lesson-overview-${lesson.id}`}
    >
      <header className="lesson-overview__header">
        <label className="lesson-overview__title-label">
          <span className="lesson-overview__title-label-text">
            {/* KS-2595: правильный i18n-ключ для лейбла НАЗВАНИЯ урока.
                До этого использовался `lessons.my.editor.fields.text.body`
                («Текст урока» / «Markdown body») — это про markdown-body
                шага типа `text`, не про название урока. На скриншоте
                пользователя из Telegram это сбивало с толку. */}
            {t('lessons.my.editor.lessonTitle', 'Lesson title')}
          </span>
          <input
            type="text"
            className="lesson-overview__title-input"
            value={lesson.title}
            disabled={busy}
            onChange={(e) => onTitleChange(e.target.value)}
            data-testid={`lesson-overview-title-${lesson.id}`}
          />
        </label>
        <label className="lesson-overview__est-label">
          <span className="lesson-overview__est-label-text">
            {t('lessons.my.editor.estMinutes', 'Estimated minutes')}
          </span>
          <input
            type="number"
            min={0}
            className="lesson-overview__est-input"
            value={lesson.estMinutes ?? ''}
            disabled={busy}
            onChange={(e) => {
              const v = e.target.value === '' ? null : Math.max(0, Number(e.target.value));
              onEstMinutesChange(v);
            }}
            data-testid={`lesson-overview-est-${lesson.id}`}
          />
        </label>
        <button
          type="button"
          className="lesson-overview__delete"
          onClick={onDeleteLesson}
          disabled={busy}
          data-testid={`lesson-overview-delete-${lesson.id}`}
        >
          {/* KS-2595: явный контекст «Удалить урок» вместо просто «Удалить»
              — на скриншоте пользователя кнопка «Удалить» висела без
              пояснения что именно удаляет. */}
          {t('lessons.my.editor.deleteLesson', 'Delete lesson')}
        </button>
      </header>

      {steps.length === 0 ? (
        <AddStepEmptyState
          onAdd={(type) => onAddStep(type)}
          busy={busy}
        />
      ) : (
        <>
          {dndEnabled && onReorderSteps ? (
            <ReorderableList itemIds={stepIds} onReorder={onReorderSteps}>
              <ol
                className="lesson-overview__steps"
                data-testid={`lesson-overview-steps-${lesson.id}`}
              >
                {steps.map((step, i) => (
                  <SortableItem key={step.id} id={step.id}>
                    {(h) => (
                      <li
                        ref={h.containerRef}
                        style={h.style}
                        className={
                          'lesson-overview__step-item' +
                          (h.isOver
                            ? ' lesson-overview__step-item--dnd-over'
                            : '') +
                          (h.isDragging
                            ? ' lesson-overview__step-item--dragging'
                            : '')
                        }
                        data-testid={`lesson-overview-step-item-${step.id}`}
                        data-dnd-over={h.isOver ? 'true' : undefined}
                        data-dnd-dragging={h.isDragging ? 'true' : undefined}
                      >
                        <div className="lesson-overview__reorder-controls">
                          <button
                            type="button"
                            disabled={busy || i === 0}
                            onClick={() => onMoveStep(step.id, -1)}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              e.nativeEvent.stopPropagation();
                            }}
                            data-testid={`lesson-overview-step-up-${step.id}`}
                            aria-label={t('editor.moveUp', 'Move up')}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            disabled={busy || i === steps.length - 1}
                            onClick={() => onMoveStep(step.id, 1)}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              e.nativeEvent.stopPropagation();
                            }}
                            data-testid={`lesson-overview-step-down-${step.id}`}
                            aria-label={t('editor.moveDown', 'Move down')}
                          >
                            ↓
                          </button>
                        </div>
                        <StepCard
                          step={step}
                          index={i}
                          expanded={expandedStepIds.has(step.id)}
                          saveStatus={
                            stepSaveStatusById?.[step.id] ?? 'idle'
                          }
                          onToggleExpand={() => onToggleStepExpand(step.id)}
                          onPayloadChange={(p) =>
                            onStepPayloadChange(step.id, p)
                          }
                          onDelete={() => onDeleteStep(step.id)}
                          onDuplicate={() => onDuplicateStep(step.id)}
                          dragHandleProps={{
                            ref: h.handleRef,
                            ...h.attributes,
                            ...h.listeners,
                          }}
                        />
                      </li>
                    )}
                  </SortableItem>
                ))}
              </ol>
            </ReorderableList>
          ) : (
            <ol
              className="lesson-overview__steps"
              data-testid={`lesson-overview-steps-${lesson.id}`}
            >
              {steps.map((step, i) => (
                <li
                  key={step.id}
                  className="lesson-overview__step-item"
                  data-testid={`lesson-overview-step-item-${step.id}`}
                >
                  <div className="lesson-overview__reorder-controls">
                    <button
                      type="button"
                      disabled={busy || i === 0}
                      onClick={() => onMoveStep(step.id, -1)}
                      data-testid={`lesson-overview-step-up-${step.id}`}
                      aria-label={t('editor.moveUp', 'Move up')}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={busy || i === steps.length - 1}
                      onClick={() => onMoveStep(step.id, 1)}
                      data-testid={`lesson-overview-step-down-${step.id}`}
                      aria-label={t('editor.moveDown', 'Move down')}
                    >
                      ↓
                    </button>
                  </div>
                  <StepCard
                    step={step}
                    index={i}
                    expanded={expandedStepIds.has(step.id)}
                    saveStatus={stepSaveStatusById?.[step.id] ?? 'idle'}
                    onToggleExpand={() => onToggleStepExpand(step.id)}
                    onPayloadChange={(p) => onStepPayloadChange(step.id, p)}
                    onDelete={() => onDeleteStep(step.id)}
                    onDuplicate={() => onDuplicateStep(step.id)}
                  />
                </li>
              ))}
            </ol>
          )}

          <div
            className="lesson-overview__add-step"
            data-testid={`lesson-overview-add-step-${lesson.id}`}
          >
            {!pickerOpen ? (
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                disabled={busy}
                data-testid={`lesson-overview-add-step-btn-${lesson.id}`}
              >
                {t('lessons.my.editor.addStep', '+ Add step')}
              </button>
            ) : (
              <div
                className="lesson-overview__add-step-picker"
                data-testid={`lesson-overview-add-step-picker-${lesson.id}`}
              >
                <p className="lesson-overview__add-step-hint">
                  {t(
                    'lessons.my.editor.addStepPicker.confirmTitle',
                    'What kind of step is this?',
                  )}
                </p>
                <StepTypePicker
                  value={pickerType}
                  onSelect={setPickerType}
                  disabled={busy}
                  testIdPrefix={`lesson-overview-add-step-types-${lesson.id}`}
                />
                <div className="lesson-overview__add-step-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setPickerOpen(false);
                      setPickerType(null);
                    }}
                    disabled={busy}
                    data-testid={`lesson-overview-add-step-cancel-${lesson.id}`}
                  >
                    {t('lessons.my.editor.addStepPicker.cancel', 'Cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={confirmAdd}
                    disabled={!pickerType || busy}
                    data-testid={`lesson-overview-add-step-confirm-${lesson.id}`}
                  >
                    {t('lessons.my.editor.addStep', '+ Add step')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
