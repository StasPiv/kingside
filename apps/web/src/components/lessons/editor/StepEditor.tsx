import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  LessonStepType,
  PuzzleTheme,
  QuizQuestion,
  StepPayload,
} from '@kingside/shared';

import type { StepFixture } from '../../../types/editor';
import { emptyStepPayload } from '../../../types/editor';
import { StepRenderer } from '../StepRenderer';
import { MemoChessboard } from '../../MemoChessboard';

/**
 * Специализированный по `payload.type` редактор одного шага (L-27 / KS-1805).
 *
 * Редактор форму-based: все поля — `<input>`/`<textarea>`/`<select>`. Для
 * диаграмм и позиции показывается мини-доска через `MemoChessboard`
 * (read-only — редактор FEN'а через drag'n'drop — отдельная большая
 * задача, вне scope MVP).
 *
 * Предпросмотр (`StepRenderer` с тем же payload'ом, что и в проде)
 * монтируется в хвост редактора — автор сразу видит, что получится.
 */

const STEP_TYPES: LessonStepType[] = [
  'text',
  'puzzle',
  'quiz',
  'position',
  'game_review',
  'video',
  'endgame_drill',
];

interface StepEditorProps {
  step: StepFixture;
  onChange: (next: StepFixture) => void;
  onRemove: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

export function StepEditor({
  step,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: StepEditorProps) {
  const { t } = useTranslation();

  const updatePayload = (payload: StepPayload) => {
    onChange({ ...step, payload });
  };

  const changeType = (type: LessonStepType) => {
    onChange({ ...step, type, payload: emptyStepPayload(type) });
  };

  return (
    <div
      className="editor-step"
      data-testid={`editor-step-${step.id}`}
      data-step-type={step.type}
    >
      <header className="editor-step__header">
        <div className="editor-step__meta">
          <span className="editor-step__order">#{step.order}</span>
          <label>
            {t('editor.step.type', 'Type')}:{' '}
            <select
              value={step.type}
              onChange={(e) => changeType(e.target.value as LessonStepType)}
              data-testid={`editor-step-type-${step.id}`}
            >
              {STEP_TYPES.map((tp) => (
                <option key={tp} value={tp}>
                  {tp}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="editor-step__actions">
          {onMoveUp && (
            <button
              type="button"
              onClick={onMoveUp}
              data-testid={`editor-step-up-${step.id}`}
              title={t('editor.moveUp', 'Move up')}
            >
              ↑
            </button>
          )}
          {onMoveDown && (
            <button
              type="button"
              onClick={onMoveDown}
              data-testid={`editor-step-down-${step.id}`}
              title={t('editor.moveDown', 'Move down')}
            >
              ↓
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            data-testid={`editor-step-remove-${step.id}`}
            className="editor-step__remove"
          >
            {t('editor.remove', 'Remove')}
          </button>
        </div>
      </header>

      <div className="editor-step__body">
        {step.payload.type === 'text' && (
          <TextFields payload={step.payload} onChange={updatePayload} />
        )}
        {step.payload.type === 'puzzle' && (
          <PuzzleFields payload={step.payload} onChange={updatePayload} />
        )}
        {step.payload.type === 'quiz' && (
          <QuizFields payload={step.payload} onChange={updatePayload} />
        )}
        {step.payload.type === 'position' && (
          <PositionFields payload={step.payload} onChange={updatePayload} />
        )}
        {step.payload.type === 'game_review' && (
          <GameReviewFields payload={step.payload} onChange={updatePayload} />
        )}
        {step.payload.type === 'video' && (
          <VideoFields payload={step.payload} onChange={updatePayload} />
        )}
        {step.payload.type === 'endgame_drill' && (
          <EndgameDrillFields payload={step.payload} onChange={updatePayload} />
        )}
      </div>

      <StepPreview step={step} />
    </div>
  );
}

// ─── TextStep fields ─────────────────────────────────────────────────

function TextFields({
  payload,
  onChange,
}: {
  payload: Extract<StepPayload, { type: 'text' }>;
  onChange: (p: StepPayload) => void;
}) {
  const { t } = useTranslation();
  const diagrams = payload.diagrams ?? [];
  return (
    <div className="editor-step__fields">
      <label>
        {t('editor.step.text.body', 'Markdown body')}
        <textarea
          value={payload.bodyMarkdown ?? ''}
          onChange={(e) => onChange({ ...payload, bodyMarkdown: e.target.value })}
          rows={8}
          data-testid="editor-step-text-body"
        />
      </label>
      <div className="editor-diagrams">
        <h4>{t('editor.step.text.diagrams', 'Diagrams')}</h4>
        {diagrams.map((d, i) => (
          <div key={i} className="editor-diagram">
            <label>
              FEN
              <input
                value={d.fen}
                onChange={(e) => {
                  const next = diagrams.slice();
                  next[i] = { ...next[i], fen: e.target.value };
                  onChange({ ...payload, diagrams: next });
                }}
                data-testid={`editor-diagram-fen-${i}`}
              />
            </label>
            <label>
              {t('editor.step.text.caption', 'Caption')}
              <input
                value={d.caption ?? ''}
                onChange={(e) => {
                  const next = diagrams.slice();
                  next[i] = { ...next[i], caption: e.target.value };
                  onChange({ ...payload, diagrams: next });
                }}
              />
            </label>
            <label>
              {t('editor.step.text.orientation', 'Orientation')}
              <select
                value={d.orientation ?? 'white'}
                onChange={(e) => {
                  const next = diagrams.slice();
                  next[i] = {
                    ...next[i],
                    orientation: e.target.value as 'white' | 'black',
                  };
                  onChange({ ...payload, diagrams: next });
                }}
              >
                <option value="white">white</option>
                <option value="black">black</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => {
                const next = diagrams.slice();
                next.splice(i, 1);
                onChange({ ...payload, diagrams: next });
              }}
            >
              −
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            onChange({
              ...payload,
              diagrams: [
                ...diagrams,
                {
                  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                  orientation: 'white',
                },
              ],
            })
          }
          data-testid="editor-step-text-add-diagram"
        >
          + {t('editor.step.text.addDiagram', 'Add diagram')}
        </button>
      </div>
    </div>
  );
}

// ─── PuzzleStep fields ───────────────────────────────────────────────

function PuzzleFields({
  payload,
  onChange,
}: {
  payload: Extract<StepPayload, { type: 'puzzle' }>;
  onChange: (p: StepPayload) => void;
}) {
  const { t } = useTranslation();
  const mode = payload.selection.mode;

  return (
    <div className="editor-step__fields">
      <label>
        {t('editor.step.puzzle.mode', 'Selection mode')}
        <select
          value={mode}
          onChange={(e) => {
            const nextMode = e.target.value as 'ids' | 'filter';
            onChange({
              ...payload,
              selection:
                nextMode === 'ids'
                  ? { mode: 'ids', puzzleIds: [] }
                  : { mode: 'filter', themes: [], limit: 5 },
            });
          }}
          data-testid="editor-step-puzzle-mode"
        >
          <option value="ids">ids</option>
          <option value="filter">filter</option>
        </select>
      </label>

      {payload.selection.mode === 'ids' && (
        <label>
          {t('editor.step.puzzle.ids', 'Puzzle IDs (comma-separated)')}
          <textarea
            rows={3}
            value={payload.selection.puzzleIds.join(', ')}
            onChange={(e) => {
              const ids = e.target.value
                .split(/[,\s]+/)
                .map((s) => s.trim())
                .filter(Boolean);
              onChange({
                ...payload,
                selection: { mode: 'ids', puzzleIds: ids },
              });
            }}
            data-testid="editor-step-puzzle-ids"
          />
        </label>
      )}

      {payload.selection.mode === 'filter' && (
        <>
          <label>
            {t('editor.step.puzzle.themes', 'Themes (comma-separated)')}
            <input
              value={payload.selection.themes.join(', ')}
              onChange={(e) => {
                const themes = e.target.value
                  .split(/[,\s]+/)
                  .map((s) => s.trim())
                  .filter(Boolean) as PuzzleTheme[];
                onChange({
                  ...payload,
                  selection: { ...payload.selection, themes },
                });
              }}
              data-testid="editor-step-puzzle-themes"
            />
          </label>
          <label>
            {t('editor.step.puzzle.ratingMin', 'Rating min')}
            <input
              type="number"
              value={payload.selection.ratingMin ?? ''}
              onChange={(e) => {
                const v = e.target.value === '' ? undefined : Number(e.target.value);
                onChange({
                  ...payload,
                  selection: {
                    ...(payload.selection as Extract<
                      typeof payload.selection,
                      { mode: 'filter' }
                    >),
                    ratingMin: v,
                  },
                });
              }}
            />
          </label>
          <label>
            {t('editor.step.puzzle.ratingMax', 'Rating max')}
            <input
              type="number"
              value={payload.selection.ratingMax ?? ''}
              onChange={(e) => {
                const v = e.target.value === '' ? undefined : Number(e.target.value);
                onChange({
                  ...payload,
                  selection: {
                    ...(payload.selection as Extract<
                      typeof payload.selection,
                      { mode: 'filter' }
                    >),
                    ratingMax: v,
                  },
                });
              }}
            />
          </label>
          <label>
            {t('editor.step.puzzle.limit', 'Limit')}
            <input
              type="number"
              min={1}
              value={payload.selection.limit}
              onChange={(e) =>
                onChange({
                  ...payload,
                  selection: {
                    ...(payload.selection as Extract<
                      typeof payload.selection,
                      { mode: 'filter' }
                    >),
                    limit: Math.max(1, Number(e.target.value)),
                  },
                })
              }
            />
          </label>
        </>
      )}

      <label>
        {t('editor.step.puzzle.minSolved', 'Min solved')}
        <input
          type="number"
          value={payload.minSolved ?? ''}
          onChange={(e) => {
            const v = e.target.value === '' ? undefined : Number(e.target.value);
            onChange({ ...payload, minSolved: v });
          }}
        />
      </label>
    </div>
  );
}

// ─── QuizStep fields ─────────────────────────────────────────────────

function QuizFields({
  payload,
  onChange,
}: {
  payload: Extract<StepPayload, { type: 'quiz' }>;
  onChange: (p: StepPayload) => void;
}) {
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
              {t('editor.step.quiz.promptKey', 'Prompt i18n key')}
              <input
                value={q.promptI18nKey}
                onChange={(e) =>
                  update(i, (qq) => ({ ...qq, promptI18nKey: e.target.value }))
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
                    value={opt.labelI18nKey}
                    onChange={(e) =>
                      update(i, (qq) => {
                        const opts = qq.options.slice();
                        opts[j] = { ...opts[j], labelI18nKey: e.target.value };
                        return { ...qq, options: opts };
                      })
                    }
                    placeholder="label i18n key"
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
                        labelI18nKey: '',
                      },
                    ],
                  }))
                }
              >
                + option
              </button>
            </div>

            <label>
              {t('editor.step.quiz.explanationKey', 'Explanation i18n key')}
              <input
                value={q.explanationI18nKey ?? ''}
                onChange={(e) =>
                  update(i, (qq) => ({
                    ...qq,
                    explanationI18nKey: e.target.value || undefined,
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
                  promptI18nKey: '',
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

// ─── PositionStep fields ─────────────────────────────────────────────

function PositionFields({
  payload,
  onChange,
}: {
  payload: Extract<StepPayload, { type: 'position' }>;
  onChange: (p: StepPayload) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="editor-step__fields">
      <label>
        FEN
        <input
          value={payload.fen}
          onChange={(e) => onChange({ ...payload, fen: e.target.value })}
          data-testid="editor-step-position-fen"
        />
      </label>
      <label>
        {t('editor.step.position.expected', 'Expected moves (UCI, comma-separated)')}
        <input
          value={payload.expectedMoves.join(', ')}
          onChange={(e) =>
            onChange({
              ...payload,
              expectedMoves: e.target.value
                .split(/[,\s]+/)
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          data-testid="editor-step-position-expected"
        />
      </label>
      <label>
        {t('editor.step.text.orientation', 'Orientation')}
        <select
          value={payload.orientation ?? 'white'}
          onChange={(e) =>
            onChange({
              ...payload,
              orientation: e.target.value as 'white' | 'black',
            })
          }
        >
          <option value="white">white</option>
          <option value="black">black</option>
        </select>
      </label>
      <div className="editor-mini-board">
        <MemoChessboard
          options={{
            position: payload.fen,
            boardOrientation: payload.orientation ?? 'white',
            allowDragging: false,
            showNotation: true,
            animationDurationInMs: 0,
          }}
        />
      </div>
    </div>
  );
}

// ─── GameReviewStep fields ───────────────────────────────────────────

function GameReviewFields({
  payload,
  onChange,
}: {
  payload: Extract<StepPayload, { type: 'game_review' }>;
  onChange: (p: StepPayload) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="editor-step__fields">
      <p className="editor-hint">
        {t(
          'editor.step.gameReview.hint',
          'Provide either gameId (DB id) OR pgn. Backend validator enforces XOR.',
        )}
      </p>
      <label>
        gameId
        <input
          value={payload.gameId ?? ''}
          onChange={(e) =>
            onChange({ ...payload, gameId: e.target.value || undefined })
          }
          data-testid="editor-step-gamereview-id"
        />
      </label>
      <label>
        PGN
        <textarea
          rows={6}
          value={payload.pgn ?? ''}
          onChange={(e) =>
            onChange({ ...payload, pgn: e.target.value || undefined })
          }
          data-testid="editor-step-gamereview-pgn"
        />
      </label>
    </div>
  );
}

// ─── VideoStep fields ────────────────────────────────────────────────

function VideoFields({
  payload,
  onChange,
}: {
  payload: Extract<StepPayload, { type: 'video' }>;
  onChange: (p: StepPayload) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="editor-step__fields">
      <label>
        URL
        <input
          value={payload.url}
          onChange={(e) => onChange({ ...payload, url: e.target.value })}
          data-testid="editor-step-video-url"
          placeholder="https://www.youtube.com/watch?v=..."
        />
      </label>
      <label>
        {t('editor.step.video.titleKey', 'Title i18n key (optional)')}
        <input
          value={payload.titleI18nKey ?? ''}
          onChange={(e) =>
            onChange({
              ...payload,
              titleI18nKey: e.target.value || undefined,
            })
          }
        />
      </label>
    </div>
  );
}

// ─── EndgameDrillStep fields ─────────────────────────────────────────

function EndgameDrillFields({
  payload,
  onChange,
}: {
  payload: Extract<StepPayload, { type: 'endgame_drill' }>;
  onChange: (p: StepPayload) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="editor-step__fields">
      <label>
        FEN
        <input
          value={payload.fen}
          onChange={(e) => onChange({ ...payload, fen: e.target.value })}
        />
      </label>
      <label>
        {t('editor.step.endgame.side', 'Player side')}
        <select
          value={payload.playerSide}
          onChange={(e) =>
            onChange({
              ...payload,
              playerSide: e.target.value as 'white' | 'black',
            })
          }
        >
          <option value="white">white</option>
          <option value="black">black</option>
        </select>
      </label>
      <label>
        {t('editor.step.endgame.skill', 'Skill level (0..20)')}
        <input
          type="number"
          min={0}
          max={20}
          value={payload.skillLevel}
          onChange={(e) =>
            onChange({
              ...payload,
              skillLevel: Math.max(0, Math.min(20, Number(e.target.value))),
            })
          }
        />
      </label>
      <label>
        {t('editor.step.endgame.winKind', 'Win condition')}
        <select
          value={payload.winCondition.kind}
          onChange={(e) => {
            const kind = e.target.value as
              | 'mate'
              | 'promote'
              | 'reach_position'
              | 'material_advantage';
            if (kind === 'reach_position') {
              onChange({
                ...payload,
                winCondition: { kind: 'reach_position', fen: payload.fen },
              });
            } else if (kind === 'material_advantage') {
              onChange({
                ...payload,
                winCondition: { kind: 'material_advantage', amount: 1 },
              });
            } else {
              onChange({ ...payload, winCondition: { kind } });
            }
          }}
        >
          <option value="mate">mate</option>
          <option value="promote">promote</option>
          <option value="reach_position">reach_position</option>
          <option value="material_advantage">material_advantage</option>
        </select>
      </label>
      {payload.winCondition.kind === 'reach_position' && (
        <label>
          {t('editor.step.endgame.targetFen', 'Target FEN')}
          <input
            value={payload.winCondition.fen}
            onChange={(e) =>
              onChange({
                ...payload,
                winCondition: { kind: 'reach_position', fen: e.target.value },
              })
            }
          />
        </label>
      )}
      {payload.winCondition.kind === 'material_advantage' && (
        <label>
          {t('editor.step.endgame.amount', 'Advantage (pawns)')}
          <input
            type="number"
            min={1}
            value={payload.winCondition.amount}
            onChange={(e) =>
              onChange({
                ...payload,
                winCondition: {
                  kind: 'material_advantage',
                  amount: Math.max(1, Number(e.target.value)),
                },
              })
            }
          />
        </label>
      )}
      <label>
        maxMoves
        <input
          type="number"
          value={payload.maxMoves ?? ''}
          onChange={(e) =>
            onChange({
              ...payload,
              maxMoves:
                e.target.value === '' ? undefined : Number(e.target.value),
            })
          }
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={Boolean(payload.hintsAllowed)}
          onChange={(e) =>
            onChange({ ...payload, hintsAllowed: e.target.checked })
          }
        />
        {t('editor.step.endgame.hints', 'Hints allowed')}
      </label>
    </div>
  );
}

// ─── Preview ──────────────────────────────────────────────────────────

function StepPreview({ step }: { step: StepFixture }) {
  const { t } = useTranslation();
  // Синтетический LessonStep — StepRenderer ждёт полный shape с id/lessonId.
  // Для preview'а достаточно id'ов-пустышек.
  const syntheticStep = useMemo(
    () => ({
      id: `preview-${step.id}`,
      lessonId: 'preview-lesson',
      order: step.order,
      type: step.type,
      payload: step.payload,
    }),
    [step],
  );

  return (
    <details className="editor-step__preview" data-testid={`editor-step-preview-${step.id}`}>
      <summary>{t('editor.preview', 'Preview')}</summary>
      <div className="editor-step__preview-body">
        <StepRenderer step={syntheticStep} hideNext />
      </div>
    </details>
  );
}
