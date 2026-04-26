import { useTranslation } from 'react-i18next';
import type { QuizQuestion, StepPayload } from '@kingside/shared';

/**
 * `QuizFields` — форма редактирования `QuizStepPayload` (KS-1849 / FE-R1).
 *
 * Вопросы и варианты ответов — вложенные списки. `passThreshold` — доля
 * правильных ответов для прохождения (0..1). Вынесено из `StepEditor.tsx`.
 */

interface QuizFieldsProps {
  payload: Extract<StepPayload, { type: 'quiz' }>;
  onChange: (p: StepPayload) => void;
}

export function QuizFields({ payload, onChange }: QuizFieldsProps) {
  const { t } = useTranslation();
  const questions = payload.questions;

  const update = (idx: number, updater: (q: QuizQuestion) => QuizQuestion) => {
    const next = questions.slice();
    next[idx] = updater(next[idx]);
    onChange({ ...payload, questions: next });
  };

  return (
    <div className="editor-step__fields">
      <label>
        {t('editor.step.quiz.threshold', 'Pass threshold (0..1)')}
        <input
          type="number"
          step="0.05"
          min={0}
          max={1}
          value={payload.passThreshold ?? ''}
          onChange={(e) =>
            onChange({
              ...payload,
              passThreshold:
                e.target.value === '' ? undefined : Number(e.target.value),
            })
          }
        />
      </label>

      <div className="editor-quiz-questions">
        {questions.map((q, i) => (
          <div
            key={q.id}
            className="editor-quiz-question"
            data-testid={`editor-quiz-q-${i}`}
          >
            <label>
              {t('editor.step.quiz.prompt', 'Prompt')}
              <input
                value={q.prompt}
                onChange={(e) =>
                  update(i, (qq) => ({ ...qq, prompt: e.target.value }))
                }
              />
            </label>
            <label>
              FEN (optional)
              <input
                value={q.fen ?? ''}
                onChange={(e) =>
                  update(i, (qq) => ({
                    ...qq,
                    fen: e.target.value || undefined,
                  }))
                }
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={Boolean(q.multi)}
                onChange={(e) => update(i, (qq) => ({ ...qq, multi: e.target.checked }))}
              />
              {t('editor.step.quiz.multi', 'Multiple correct')}
            </label>

            <div className="editor-quiz-options">
              <h5>{t('editor.step.quiz.options', 'Options')}</h5>
              {q.options.map((opt, j) => (
                <div key={opt.id} className="editor-quiz-option">
                  <input
                    value={opt.id}
                    onChange={(e) =>
                      update(i, (qq) => {
                        const opts = qq.options.slice();
                        opts[j] = { ...opts[j], id: e.target.value };
                        return { ...qq, options: opts };
                      })
                    }
                    placeholder="id"
                  />
                  <input
                    value={opt.label}
                    onChange={(e) =>
                      update(i, (qq) => {
                        const opts = qq.options.slice();
                        opts[j] = { ...opts[j], label: e.target.value };
                        return { ...qq, options: opts };
                      })
                    }
                    placeholder="label"
                  />
                  <label>
                    <input
                      type="checkbox"
                      checked={q.correctOptionIds.includes(opt.id)}
                      onChange={(e) =>
                        update(i, (qq) => {
                          const set = new Set(qq.correctOptionIds);
                          if (e.target.checked) set.add(opt.id);
                          else set.delete(opt.id);
                          return { ...qq, correctOptionIds: Array.from(set) };
                        })
                      }
                    />
                    {t('editor.step.quiz.correct', 'Correct')}
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      update(i, (qq) => {
                        const opts = qq.options.slice();
                        opts.splice(j, 1);
                        return {
                          ...qq,
                          options: opts,
                          correctOptionIds: qq.correctOptionIds.filter(
                            (id) => id !== opt.id,
                          ),
                        };
                      })
                    }
                  >
                    −
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  update(i, (qq) => ({
                    ...qq,
                    options: [
                      ...qq.options,
                      {
                        id: `opt-${qq.options.length + 1}`,
                        label: '',
                      },
                    ],
                  }))
                }
              >
                + option
              </button>
            </div>

            <label>
              {t('editor.step.quiz.explanation', 'Explanation (optional)')}
              <input
                value={q.explanation ?? ''}
                onChange={(e) =>
                  update(i, (qq) => ({
                    ...qq,
                    explanation: e.target.value || undefined,
                  }))
                }
              />
            </label>

            <button
              type="button"
              onClick={() => {
                const next = questions.slice();
                next.splice(i, 1);
                onChange({ ...payload, questions: next });
              }}
              data-testid={`editor-quiz-q-remove-${i}`}
            >
              − {t('editor.step.quiz.removeQuestion', 'Remove question')}
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            onChange({
              ...payload,
              questions: [
                ...questions,
                {
                  id: `q-${questions.length + 1}`,
                  prompt: '',
                  options: [],
                  correctOptionIds: [],
                },
              ],
            })
          }
          data-testid="editor-quiz-add-question"
        >
          + {t('editor.step.quiz.addQuestion', 'Add question')}
        </button>
      </div>
    </div>
  );
}
