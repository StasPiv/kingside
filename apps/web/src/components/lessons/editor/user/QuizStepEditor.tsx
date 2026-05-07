import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  QuizOption,
  QuizQuestion,
  QuizStepPayload,
} from '@kingside/shared';

import { DiagramEditor } from '../shared/DiagramEditor';
import { ReorderableList, SortableItem } from './dnd/ReorderableList';

/**
 * `QuizStepEditor` — редактор `QuizStepPayload` для user-courses
 * (KS-2573). До этого тикета авторам приходилось редактировать quiz
 * через JSON в admin-режиме (`QuizFields` в `apps/web/src/components/
 * lessons/editor/fields/QuizFields.tsx` — устаревший inline-редактор).
 *
 * Возможности:
 *  - список `payload.questions[]` — collapsible-карточки.
 *  - drag-reorder вопросов и опций через `@dnd-kit` (через нашу
 *    обёртку `ReorderableList` / `SortableItem`).
 *  - prompt + опц. FEN (через `<DiagramEditor drawingDisabled>` —
 *    стрелки/highlights в quiz не нужны, только FEN-picker), список
 *    опций (text + checkbox «правильный»), explanation.
 *  - кнопки на уровне вопроса: дублировать, удалить, collapse.
 *  - кнопка «+ Добавить опцию» (UI-лимит 2..6, backend валидирует своё).
 *  - кнопка «+ Добавить вопрос» внизу.
 *
 * Валидация (только подсветка, не блокировка): красная рамка если
 *  - prompt пустой,
 *  - options.length < 2,
 *  - есть опция с пустым `label`,
 *  - `correctOptionIds[]` пустой.
 *
 * Опция id'ы — буквы a/b/c/d/e/f. При добавлении новой опции берём
 * lowest unused letter, чтобы id не зависели от текущей длины массива
 * (важно для reorder — id не меняется).
 *
 * **Не меняет** viewer (`QuizStep.tsx`), shared-типы, backend whitelist
 * — это отдельные тикеты.
 */

interface QuizStepEditorProps {
  payload: QuizStepPayload;
  onChange: (next: QuizStepPayload) => void;
}

const OPTION_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const MAX_OPTIONS_UI = 6;
const MIN_OPTIONS_UI = 2;

function nextOptionId(existing: QuizOption[]): string {
  const used = new Set(existing.map((o) => o.id));
  for (const ch of OPTION_ID_ALPHABET) {
    if (!used.has(ch)) return ch;
  }
  // fallback — крайне маловероятно, но не падаем
  return `opt-${existing.length + 1}-${Date.now().toString(36)}`;
}

function nextQuestionId(existing: QuizQuestion[]): string {
  // q-1, q-2, …; ищем минимальный незанятый суффикс.
  const used = new Set(existing.map((q) => q.id));
  let i = 1;
  while (used.has(`q-${i}`)) i++;
  return `q-${i}`;
}

function makeDefaultQuestion(existing: QuizQuestion[]): QuizQuestion {
  return {
    id: nextQuestionId(existing),
    prompt: '',
    options: [
      { id: 'a', label: '' },
      { id: 'b', label: '' },
    ],
    correctOptionIds: [],
  };
}

interface QuestionValidation {
  promptEmpty: boolean;
  tooFewOptions: boolean;
  emptyOption: boolean;
  noCorrect: boolean;
  hasError: boolean;
}

function validateQuestion(q: QuizQuestion): QuestionValidation {
  const promptEmpty = q.prompt.trim().length === 0;
  const tooFewOptions = q.options.length < MIN_OPTIONS_UI;
  const emptyOption = q.options.some((o) => o.label.trim().length === 0);
  const noCorrect = q.correctOptionIds.length === 0;
  return {
    promptEmpty,
    tooFewOptions,
    emptyOption,
    noCorrect,
    hasError: promptEmpty || tooFewOptions || emptyOption || noCorrect,
  };
}

export function QuizStepEditor({ payload, onChange }: QuizStepEditorProps) {
  const { t } = useTranslation();
  const questions = payload.questions;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // ----- updaters -----
  const updateQuestion = useCallback(
    (idx: number, updater: (q: QuizQuestion) => QuizQuestion) => {
      const next = questions.slice();
      const cur = next[idx];
      if (!cur) return;
      next[idx] = updater(cur);
      onChange({ ...payload, questions: next });
    },
    [questions, payload, onChange],
  );

  const removeQuestion = useCallback(
    (idx: number) => {
      const next = questions.slice();
      next.splice(idx, 1);
      onChange({ ...payload, questions: next });
    },
    [questions, payload, onChange],
  );

  const duplicateQuestion = useCallback(
    (idx: number) => {
      const next = questions.slice();
      const src = next[idx];
      if (!src) return;
      const copy: QuizQuestion = {
        ...src,
        id: nextQuestionId(next),
        options: src.options.map((o) => ({ ...o })),
        correctOptionIds: src.correctOptionIds.slice(),
      };
      next.splice(idx + 1, 0, copy);
      onChange({ ...payload, questions: next });
    },
    [questions, payload, onChange],
  );

  const addQuestion = useCallback(() => {
    onChange({
      ...payload,
      questions: [...questions, makeDefaultQuestion(questions)],
    });
  }, [questions, payload, onChange]);

  const reorderQuestions = useCallback(
    (orderedIds: string[]) => {
      const map = new Map(questions.map((q) => [q.id, q]));
      const next = orderedIds
        .map((id) => map.get(id))
        .filter((q): q is QuizQuestion => Boolean(q));
      onChange({ ...payload, questions: next });
    },
    [questions, payload, onChange],
  );

  const reorderOptions = useCallback(
    (qIdx: number, orderedIds: string[]) => {
      updateQuestion(qIdx, (q) => {
        const map = new Map(q.options.map((o) => [o.id, o]));
        const opts = orderedIds
          .map((id) => map.get(id))
          .filter((o): o is QuizOption => Boolean(o));
        return { ...q, options: opts };
      });
    },
    [updateQuestion],
  );

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  // ----- option ops -----
  const addOption = (qIdx: number) =>
    updateQuestion(qIdx, (q) => {
      if (q.options.length >= MAX_OPTIONS_UI) return q;
      const id = nextOptionId(q.options);
      return { ...q, options: [...q.options, { id, label: '' }] };
    });

  const removeOption = (qIdx: number, optId: string) =>
    updateQuestion(qIdx, (q) => ({
      ...q,
      options: q.options.filter((o) => o.id !== optId),
      correctOptionIds: q.correctOptionIds.filter((id) => id !== optId),
    }));

  const setOptionLabel = (qIdx: number, optId: string, label: string) =>
    updateQuestion(qIdx, (q) => ({
      ...q,
      options: q.options.map((o) => (o.id === optId ? { ...o, label } : o)),
    }));

  const toggleOptionCorrect = (qIdx: number, optId: string) =>
    updateQuestion(qIdx, (q) => {
      const isCorrect = q.correctOptionIds.includes(optId);
      let nextIds: string[];
      if (isCorrect) {
        nextIds = q.correctOptionIds.filter((id) => id !== optId);
      } else if (q.multi) {
        nextIds = [...q.correctOptionIds, optId];
      } else {
        // single-correct (default): отметить новый = снять остальные
        nextIds = [optId];
      }
      return { ...q, correctOptionIds: nextIds };
    });

  // ----- FEN ops (через DiagramEditor drawingDisabled) -----
  const STARTING_FEN =
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const addFen = (qIdx: number) =>
    updateQuestion(qIdx, (q) => ({ ...q, fen: q.fen ?? STARTING_FEN }));
  const removeFen = (qIdx: number) =>
    updateQuestion(qIdx, (q) => {
      const { fen: _omit, ...rest } = q;
      void _omit;
      return rest;
    });

  const questionIds = useMemo(() => questions.map((q) => q.id), [questions]);

  return (
    <div className="quiz-step-editor" data-testid="quiz-step-editor">
      <div className="quiz-step-editor__threshold">
        <label>
          {t('editor.step.quiz.threshold', 'Pass threshold (0..1)')}
          <input
            type="number"
            step="0.05"
            min={0}
            max={1}
            value={payload.passThreshold ?? ''}
            data-testid="quiz-pass-threshold"
            onChange={(e) =>
              onChange({
                ...payload,
                passThreshold:
                  e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
          />
        </label>
      </div>

      <h4
        className="quiz-step-editor__questions-title"
        data-testid="quiz-questions-title"
      >
        {t('lessons.my.editor.quiz.questions.title', 'Questions')}
      </h4>

      <ReorderableList itemIds={questionIds} onReorder={reorderQuestions}>
        <ol className="quiz-step-editor__questions">
          {questions.map((q, i) => {
            const isCollapsed = collapsed[q.id] === true;
            const v = validateQuestion(q);
            return (
              <SortableItem key={q.id} id={q.id}>
                {(h) => (
                  <li
                    ref={h.containerRef}
                    style={h.style}
                    className={`quiz-question${v.hasError ? ' quiz-question--invalid' : ''}${isCollapsed ? ' quiz-question--collapsed' : ''}`}
                    data-testid={`quiz-question-${i}`}
                    data-question-id={q.id}
                    data-invalid={v.hasError ? 'true' : 'false'}
                  >
                    <div className="quiz-question__header">
                      <button
                        type="button"
                        ref={h.handleRef}
                        {...h.attributes}
                        {...h.listeners}
                        className="quiz-question__handle"
                        aria-label={t(
                          'editor.step.quiz.dragHandle',
                          'Reorder',
                        )}
                        data-testid={`quiz-question-handle-${i}`}
                      >
                        ⠿
                      </button>
                      <button
                        type="button"
                        className="quiz-question__toggle"
                        onClick={() => toggleCollapsed(q.id)}
                        aria-expanded={!isCollapsed}
                        data-testid={`quiz-question-toggle-${i}`}
                      >
                        {isCollapsed ? '▸' : '▾'}
                      </button>
                      <span className="quiz-question__title">
                        {t('editor.step.quiz.questionN', {
                          defaultValue: 'Question {{n}}',
                          n: i + 1,
                        })}
                      </span>
                      {v.hasError && (
                        <span
                          className="quiz-question__badge quiz-question__badge--invalid"
                          data-testid={`quiz-question-invalid-${i}`}
                        >
                          {t(
                            'editor.step.quiz.invalidBadge',
                            'Needs attention',
                          )}
                        </span>
                      )}
                      <span className="quiz-question__spacer" />
                      <button
                        type="button"
                        className="quiz-question__icon-btn"
                        onClick={() => duplicateQuestion(i)}
                        aria-label={t(
                          'lessons.my.editor.quiz.duplicateQuestion',
                          'Duplicate',
                        )}
                        title={t(
                          'lessons.my.editor.quiz.duplicateQuestion',
                          'Duplicate',
                        )}
                        data-testid={`quiz-question-duplicate-${i}`}
                      >
                        ⎘
                      </button>
                      <button
                        type="button"
                        className="quiz-question__icon-btn quiz-question__icon-btn--danger"
                        onClick={() => removeQuestion(i)}
                        aria-label={t(
                          'lessons.my.editor.quiz.deleteQuestion',
                          'Delete question',
                        )}
                        title={t(
                          'lessons.my.editor.quiz.deleteQuestion',
                          'Delete question',
                        )}
                        data-testid={`quiz-question-remove-${i}`}
                      >
                        −
                      </button>
                    </div>

                    {!isCollapsed && (
                      <div className="quiz-question__body">
                        <label className="quiz-question__field">
                          <span className="quiz-question__field-label">
                            {t(
                              'lessons.my.editor.quiz.questionPrompt',
                              'Question text',
                            )}
                          </span>
                          <input
                            type="text"
                            value={q.prompt}
                            data-testid={`quiz-question-prompt-${i}`}
                            className={
                              v.promptEmpty
                                ? 'quiz-question__input--invalid'
                                : ''
                            }
                            onChange={(e) =>
                              updateQuestion(i, (qq) => ({
                                ...qq,
                                prompt: e.target.value,
                              }))
                            }
                          />
                        </label>

                        <div
                          className="quiz-question__fen"
                          data-testid={`quiz-question-fen-section-${i}`}
                        >
                          {q.fen === undefined ? (
                            <button
                              type="button"
                              className="quiz-question__add-fen"
                              onClick={() => addFen(i)}
                              data-testid={`quiz-question-add-fen-${i}`}
                            >
                              {t(
                                'lessons.my.editor.quiz.questionPositionAdd',
                                'Add position',
                              )}
                            </button>
                          ) : (
                            <div className="quiz-question__fen-block">
                              <div className="quiz-question__fen-header">
                                <span>
                                  {t(
                                    'editor.step.quiz.positionLabel',
                                    'Position',
                                  )}
                                </span>
                                <button
                                  type="button"
                                  className="quiz-question__icon-btn quiz-question__icon-btn--danger"
                                  onClick={() => removeFen(i)}
                                  data-testid={`quiz-question-remove-fen-${i}`}
                                >
                                  {t(
                                    'lessons.my.editor.quiz.questionPositionRemove',
                                    'Remove position',
                                  )}
                                </button>
                              </div>
                              <DiagramEditor
                                fen={q.fen}
                                drawingDisabled
                                onChange={(next) =>
                                  updateQuestion(i, (qq) => ({
                                    ...qq,
                                    fen: next.fen,
                                  }))
                                }
                              />
                            </div>
                          )}
                        </div>

                        <div className="quiz-question__multi">
                          <label>
                            <input
                              type="checkbox"
                              checked={Boolean(q.multi)}
                              data-testid={`quiz-question-multi-${i}`}
                              onChange={(e) =>
                                updateQuestion(i, (qq) => ({
                                  ...qq,
                                  multi: e.target.checked,
                                  // если переходим на single и было >1
                                  // правильных — оставляем первый
                                  correctOptionIds:
                                    !e.target.checked &&
                                    qq.correctOptionIds.length > 1
                                      ? qq.correctOptionIds.slice(0, 1)
                                      : qq.correctOptionIds,
                                }))
                              }
                            />
                            {t(
                              'editor.step.quiz.multi',
                              'Multiple correct answers',
                            )}
                          </label>
                        </div>

                        <div
                          className={`quiz-question__options${v.tooFewOptions || v.noCorrect ? ' quiz-question__options--invalid' : ''}`}
                        >
                          <h5>
                            {t(
                              'lessons.my.editor.quiz.options.title',
                              'Options',
                            )}
                          </h5>
                          {v.tooFewOptions && (
                            <p
                              className="quiz-question__validation"
                              data-testid={`quiz-question-validation-min-${i}`}
                            >
                              {t(
                                'lessons.my.editor.quiz.validation.minOptions',
                                'At least 2 options required',
                              )}
                            </p>
                          )}
                          {v.noCorrect && (
                            <p
                              className="quiz-question__validation"
                              data-testid={`quiz-question-validation-no-correct-${i}`}
                            >
                              {t(
                                'lessons.my.editor.quiz.validation.noCorrect',
                                'Mark at least one correct option',
                              )}
                            </p>
                          )}
                          <ReorderableList
                            itemIds={q.options.map((o) => o.id)}
                            onReorder={(ids) => reorderOptions(i, ids)}
                          >
                            <ul className="quiz-question__options-list">
                              {q.options.map((opt, j) => {
                                const isCorrect =
                                  q.correctOptionIds.includes(opt.id);
                                const isEmpty = opt.label.trim().length === 0;
                                return (
                                  <SortableItem
                                    key={opt.id}
                                    id={opt.id}
                                  >
                                    {(oh) => (
                                      <li
                                        ref={oh.containerRef}
                                        style={oh.style}
                                        className={`quiz-option${isEmpty ? ' quiz-option--invalid' : ''}`}
                                        data-testid={`quiz-option-${i}-${j}`}
                                        data-option-id={opt.id}
                                      >
                                        <button
                                          type="button"
                                          ref={oh.handleRef}
                                          {...oh.attributes}
                                          {...oh.listeners}
                                          className="quiz-option__handle"
                                          aria-label={t(
                                            'editor.step.quiz.dragHandle',
                                            'Reorder',
                                          )}
                                          data-testid={`quiz-option-handle-${i}-${j}`}
                                        >
                                          ⠿
                                        </button>
                                        <input
                                          type="text"
                                          value={opt.label}
                                          className={`quiz-option__input${isEmpty ? ' quiz-option__input--invalid' : ''}`}
                                          data-testid={`quiz-option-label-${i}-${j}`}
                                          onChange={(e) =>
                                            setOptionLabel(
                                              i,
                                              opt.id,
                                              e.target.value,
                                            )
                                          }
                                          placeholder={t(
                                            'editor.step.quiz.optionPlaceholder',
                                            'Answer text…',
                                          )}
                                        />
                                        <label className="quiz-option__correct">
                                          <input
                                            type="checkbox"
                                            checked={isCorrect}
                                            data-testid={`quiz-option-correct-${i}-${j}`}
                                            onChange={() =>
                                              toggleOptionCorrect(i, opt.id)
                                            }
                                          />
                                          {t(
                                            'lessons.my.editor.quiz.optionCorrect',
                                            'Correct',
                                          )}
                                        </label>
                                        <button
                                          type="button"
                                          className="quiz-option__remove"
                                          onClick={() =>
                                            removeOption(i, opt.id)
                                          }
                                          aria-label={t(
                                            'editor.step.quiz.removeOption',
                                            'Remove option',
                                          )}
                                          data-testid={`quiz-option-remove-${i}-${j}`}
                                        >
                                          −
                                        </button>
                                      </li>
                                    )}
                                  </SortableItem>
                                );
                              })}
                            </ul>
                          </ReorderableList>
                          <button
                            type="button"
                            className="quiz-question__add-option"
                            onClick={() => addOption(i)}
                            disabled={q.options.length >= MAX_OPTIONS_UI}
                            data-testid={`quiz-add-option-${i}`}
                          >
                            {t(
                              'lessons.my.editor.quiz.addOption',
                              '+ Add option',
                            )}
                          </button>
                        </div>

                        <label className="quiz-question__field">
                          <span className="quiz-question__field-label">
                            {t(
                              'lessons.my.editor.quiz.explanation',
                              'Explanation (optional)',
                            )}
                          </span>
                          <textarea
                            value={q.explanation ?? ''}
                            data-testid={`quiz-question-explanation-${i}`}
                            rows={2}
                            onChange={(e) =>
                              updateQuestion(i, (qq) => ({
                                ...qq,
                                explanation: e.target.value || undefined,
                              }))
                            }
                          />
                        </label>
                      </div>
                    )}
                  </li>
                )}
              </SortableItem>
            );
          })}
        </ol>
      </ReorderableList>

      <button
        type="button"
        className="quiz-step-editor__add-question"
        onClick={addQuestion}
        data-testid="quiz-add-question"
      >
        {t('lessons.my.editor.quiz.addQuestion', '+ Add question')}
      </button>
    </div>
  );
}

export default QuizStepEditor;
