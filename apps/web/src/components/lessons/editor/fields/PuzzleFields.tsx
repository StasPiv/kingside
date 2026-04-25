import { useTranslation } from 'react-i18next';
import type { CustomPuzzle, PuzzleTheme, StepPayload } from '@kingside/shared';

import { CustomPuzzleField } from './CustomPuzzleField';

/**
 * `PuzzleFields` — форма редактирования `PuzzleStepPayload` (KS-1849 / FE-R1).
 *
 * Поддерживает три модели выбора задач:
 *  - `ids`    — явный список Lichess-id'ов (системная база);
 *  - `filter` — по темам/рейтингу + лимит (системная база);
 *  - `custom` — авторские задачи прямо в payload (ADR-029, KS-1909).
 *    Каждая `CustomPuzzle` хранит `fen + solutionMoves + orientation
 *    + caption + themes`.
 *
 * Переключение режима сбрасывает выбор (чтобы старое состояние не
 * протекало).
 */

const MAX_CUSTOM_PUZZLES = 20;

const DEFAULT_CUSTOM_PUZZLE: CustomPuzzle = {
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  solutionMoves: [],
};

interface PuzzleFieldsProps {
  payload: Extract<StepPayload, { type: 'puzzle' }>;
  onChange: (p: StepPayload) => void;
}

type PuzzleMode = 'ids' | 'filter' | 'custom';

export function PuzzleFields({ payload, onChange }: PuzzleFieldsProps) {
  const { t } = useTranslation();
  const mode = payload.selection.mode;

  const switchMode = (nextMode: PuzzleMode) => {
    if (nextMode === 'ids') {
      onChange({ ...payload, selection: { mode: 'ids', puzzleIds: [] } });
    } else if (nextMode === 'filter') {
      onChange({
        ...payload,
        selection: { mode: 'filter', themes: [], limit: 5 },
      });
    } else {
      onChange({
        ...payload,
        selection: { mode: 'custom', customPuzzles: [] },
      });
    }
  };

  return (
    <div className="editor-step__fields">
      <label>
        {t('editor.step.puzzle.mode', 'Selection mode')}
        <select
          value={mode}
          onChange={(e) => switchMode(e.target.value as PuzzleMode)}
          data-testid="editor-step-puzzle-mode"
        >
          <option value="ids">ids</option>
          <option value="filter">filter</option>
          <option value="custom">
            {t('editor.step.puzzle.mode.custom', 'custom')}
          </option>
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

      {payload.selection.mode === 'custom' && (
        <div
          className="custom-puzzle-list"
          data-testid="editor-step-puzzle-custom-list"
        >
          {payload.selection.customPuzzles.length === 0 && (
            <p
              className="custom-puzzle-list__empty-hint"
              data-testid="editor-step-puzzle-custom-empty-hint"
            >
              {t(
                'editor.step.puzzle.custom.emptyHint',
                'Click «+ Add custom puzzle» to add your first authored puzzle.',
              )}
            </p>
          )}
          {payload.selection.customPuzzles.map((cp, i) => (
            <CustomPuzzleField
              key={i}
              index={i}
              puzzle={cp}
              onChange={(next) => {
                if (payload.selection.mode !== 'custom') return;
                const list = payload.selection.customPuzzles.slice();
                list[i] = next;
                onChange({
                  ...payload,
                  selection: { mode: 'custom', customPuzzles: list },
                });
              }}
              onDelete={() => {
                if (payload.selection.mode !== 'custom') return;
                const list = payload.selection.customPuzzles.slice();
                list.splice(i, 1);
                onChange({
                  ...payload,
                  selection: { mode: 'custom', customPuzzles: list },
                });
              }}
            />
          ))}
          <div className="custom-puzzle-list__footer">
            <button
              type="button"
              onClick={() => {
                if (payload.selection.mode !== 'custom') return;
                const list = payload.selection.customPuzzles;
                if (list.length >= MAX_CUSTOM_PUZZLES) return;
                onChange({
                  ...payload,
                  selection: {
                    mode: 'custom',
                    customPuzzles: [...list, { ...DEFAULT_CUSTOM_PUZZLE }],
                  },
                });
              }}
              disabled={
                payload.selection.customPuzzles.length >= MAX_CUSTOM_PUZZLES
              }
              data-testid="editor-step-puzzle-custom-add"
            >
              {t(
                'editor.step.puzzle.custom.addPuzzle',
                '+ Add custom puzzle',
              )}
            </button>
            {payload.selection.customPuzzles.length >= MAX_CUSTOM_PUZZLES && (
              <span
                className="custom-puzzle-list__limit"
                data-testid="editor-step-puzzle-custom-limit"
              >
                {t(
                  'editor.step.puzzle.custom.maxPuzzles',
                  'Limit reached (max 20 puzzles)',
                )}
              </span>
            )}
          </div>
        </div>
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
