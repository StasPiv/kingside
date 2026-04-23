import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { QuizQuestion, QuizStepPayload } from '@kingside/shared';

import { MemoChessboard } from '../../MemoChessboard';

/**
 * QuizStep — мини-тест с мульти-выбором (L-10, KS-1765).
 *
 * Правильные ответы (`correctOptionIds`) хранятся в payload — проверка
 * на клиенте достаточна для MVP (ничего «секретного» в ответах нет,
 * пользователь и так видит разбор после ответа).
 *
 * Шаг считается пройденным, если доля правильно отвеченных вопросов
 * ≥ `payload.passThreshold` (по умолчанию 0.7). При прохождении порога
 * вызывается `onStepDone()` — интерфейс под `useLessonProgress` (L-11),
 * как в TextStep / PuzzleStep.
 *
 * Семантика «правильно»:
 *   • multi=false (single) — выбран ровно один вариант, и он входит в
 *     `correctOptionIds`.
 *   • multi=true            — выбранный набор совпадает с `correctOptionIds`
 *     по составу (порядок не важен, лишних не выбрано, ничего не пропущено).
 */

const DEFAULT_PASS_THRESHOLD = 0.7;

interface QuizStepProps {
  payload: QuizStepPayload;
  onStepDone?: () => void;
  hideNext?: boolean;
}

type Phase = 'answering' | 'checked';

interface QuestionState {
  selected: Set<string>;
  phase: Phase;
  /** Для статистики «решил/нет». Заполняется при переходе в `checked`. */
  correct: boolean | null;
}

function emptyState(): QuestionState {
  return { selected: new Set(), phase: 'answering', correct: null };
}

function isAnswerCorrect(question: QuizQuestion, selected: Set<string>): boolean {
  const correct = new Set(question.correctOptionIds);
  if (question.multi) {
    if (selected.size !== correct.size) return false;
    for (const id of selected) if (!correct.has(id)) return false;
    return true;
  }
  // single: ровно один выбран и он в correctOptionIds
  if (selected.size !== 1) return false;
  const [only] = selected;
  return correct.has(only);
}

export function QuizStep({ payload, onStepDone, hideNext }: QuizStepProps) {
  const { t } = useTranslation();
  const stepDoneFiredRef = useRef(false);

  const questions = payload.questions ?? [];
  const total = questions.length;
  const passThreshold = payload.passThreshold ?? DEFAULT_PASS_THRESHOLD;

  const [states, setStates] = useState<QuestionState[]>(() =>
    questions.map(() => emptyState()),
  );
  const [submitted, setSubmitted] = useState(false);

  const correctCount = useMemo(
    () => states.reduce((acc, s) => acc + (s.correct === true ? 1 : 0), 0),
    [states],
  );

  // submitted=true → шаг проверен. Доля правильных и проход.
  const ratio = submitted && total > 0 ? correctCount / total : 0;
  const passed = submitted && total > 0 && ratio >= passThreshold;

  // Поддерживаем «ленивое» проставление onStepDone — после первого
  // успешного прохождения. Повторные клики «Continue» вызывают callback
  // явно (как и в других степах).
  if (passed && !stepDoneFiredRef.current) {
    stepDoneFiredRef.current = true;
    onStepDone?.();
  }

  // ─── Handlers ─────────────────────────────────────────────────────
  const toggleOption = (qIdx: number, optionId: string) => {
    if (submitted) return;
    setStates((prev) => {
      const next = prev.slice();
      const cur = next[qIdx];
      if (cur.phase === 'checked') return prev;
      const sel = new Set(cur.selected);
      const multi = !!questions[qIdx].multi;
      if (multi) {
        if (sel.has(optionId)) sel.delete(optionId);
        else sel.add(optionId);
      } else {
        sel.clear();
        sel.add(optionId);
      }
      next[qIdx] = { ...cur, selected: sel };
      return next;
    });
  };

  const checkQuestion = (qIdx: number) => {
    setStates((prev) => {
      const next = prev.slice();
      const cur = next[qIdx];
      if (cur.phase === 'checked' || cur.selected.size === 0) return prev;
      const correct = isAnswerCorrect(questions[qIdx], cur.selected);
      next[qIdx] = { ...cur, phase: 'checked', correct };
      return next;
    });
  };

  const submitQuiz = () => {
    // Если есть ещё неотмеченные — считаем их пустые ответы как «не верно».
    setStates((prev) =>
      prev.map((s, i) => {
        if (s.phase === 'checked') return s;
        return {
          ...s,
          phase: 'checked',
          correct: isAnswerCorrect(questions[i], s.selected),
        };
      }),
    );
    setSubmitted(true);
  };

  const reset = () => {
    stepDoneFiredRef.current = false;
    setStates(questions.map(() => emptyState()));
    setSubmitted(false);
  };

  // ─── Render ───────────────────────────────────────────────────────
  if (total === 0) {
    return (
      <div className="lesson-quiz-step__empty" data-testid="lesson-quiz-step-empty">
        {t('lessons.quizEmpty', 'No questions in this quiz')}
      </div>
    );
  }

  const allChecked = states.every((s) => s.phase === 'checked');

  return (
    <div className="lesson-quiz-step" data-testid="lesson-quiz-step">
      <header className="lesson-quiz-step__header">
        <span data-testid="lesson-quiz-step-progress">
          {t('lessons.quizProgress', {
            answered: states.filter((s) => s.phase === 'checked').length,
            total,
            defaultValue: 'Answered {{answered}}/{{total}}',
          })}
        </span>
        {submitted && (
          <span data-testid="lesson-quiz-step-score">
            {t('lessons.quizScore', {
              correct: correctCount,
              total,
              percent: Math.round(ratio * 100),
              defaultValue: 'Score: {{correct}}/{{total}} ({{percent}}%)',
            })}
          </span>
        )}
      </header>

      <ol className="lesson-quiz-step__questions">
        {questions.map((q, qIdx) => {
          const state = states[qIdx];
          const correctSet = new Set(q.correctOptionIds);
          return (
            <li
              key={q.id}
              className={`lesson-quiz-question lesson-quiz-question--${state.phase}`}
              data-testid={`lesson-quiz-question-${qIdx}`}
              data-correct={state.correct == null ? '' : String(state.correct)}
            >
              <p className="lesson-quiz-question__prompt">
                {t(q.promptI18nKey, q.promptI18nKey)}
              </p>

              {q.fen && (
                <div
                  className="lesson-quiz-question__diagram"
                  style={{ width: 280, maxWidth: '100%' }}
                >
                  <MemoChessboard
                    options={{
                      position: q.fen,
                      allowDragging: false,
                      showNotation: true,
                      animationDurationInMs: 0,
                    }}
                  />
                </div>
              )}

              <ul className="lesson-quiz-question__options">
                {q.options.map((opt) => {
                  const selected = state.selected.has(opt.id);
                  const isCorrectOpt = correctSet.has(opt.id);
                  const showResult = state.phase === 'checked';
                  let optionClass = 'lesson-quiz-option';
                  if (showResult && selected && isCorrectOpt) optionClass += ' lesson-quiz-option--correct';
                  if (showResult && selected && !isCorrectOpt) optionClass += ' lesson-quiz-option--wrong';
                  if (showResult && !selected && isCorrectOpt) optionClass += ' lesson-quiz-option--missed';
                  return (
                    <li key={opt.id} className={optionClass}>
                      <label>
                        <input
                          type={q.multi ? 'checkbox' : 'radio'}
                          name={`q-${qIdx}`}
                          data-testid={`option-${qIdx}-${opt.id}`}
                          checked={selected}
                          disabled={state.phase === 'checked'}
                          onChange={() => toggleOption(qIdx, opt.id)}
                        />
                        <span>{t(opt.labelI18nKey, opt.labelI18nKey)}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>

              {state.phase === 'answering' && (
                <button
                  type="button"
                  className="lesson-quiz-question__check"
                  data-testid={`check-${qIdx}`}
                  disabled={state.selected.size === 0}
                  onClick={() => checkQuestion(qIdx)}
                >
                  {t('lessons.quizCheck', 'Check')}
                </button>
              )}

              {state.phase === 'checked' && (
                <p
                  className={`lesson-quiz-question__result lesson-quiz-question__result--${
                    state.correct ? 'correct' : 'incorrect'
                  }`}
                  data-testid={`question-result-${qIdx}`}
                >
                  {state.correct
                    ? t('lessons.quizQuestionCorrect', 'Correct')
                    : t('lessons.quizQuestionWrong', 'Not quite')}
                  {q.explanationI18nKey && (
                    <span className="lesson-quiz-question__explanation">
                      {' — '}
                      {t(q.explanationI18nKey, q.explanationI18nKey)}
                    </span>
                  )}
                </p>
              )}
            </li>
          );
        })}
      </ol>

      <div className="lesson-quiz-step__actions">
        {!submitted && (
          <button
            type="button"
            className="lesson-quiz-step__submit"
            data-testid="lesson-quiz-step-submit"
            disabled={!allChecked}
            onClick={submitQuiz}
          >
            {t('lessons.quizSubmit', 'Finish quiz')}
          </button>
        )}

        {submitted && !passed && (
          <button
            type="button"
            className="lesson-quiz-step__retry"
            data-testid="lesson-quiz-step-retry"
            onClick={reset}
          >
            {t('lessons.quizRetry', 'Try again')}
          </button>
        )}

        {submitted && !hideNext && (
          <button
            type="button"
            className="lesson-quiz-step__continue"
            data-testid="lesson-quiz-step-continue"
            disabled={!passed}
            onClick={() => onStepDone?.()}
          >
            {passed
              ? t('lessons.quizContinue', 'Continue')
              : t('lessons.quizNeedMore', 'Need ≥ {{percent}}% correct', {
                  percent: Math.round(passThreshold * 100),
                })}
          </button>
        )}
      </div>
    </div>
  );
}

// Экспорт хелпера для тестов.
export { isAnswerCorrect };
