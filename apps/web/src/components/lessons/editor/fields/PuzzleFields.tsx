import { useTranslation } from 'react-i18next';
import type { PuzzleTheme, StepPayload } from '@kingside/shared';

/**
 * `PuzzleFields` — форма редактирования `PuzzleStepPayload` (KS-1849 / FE-R1).
 *
 * Поддерживает две модели выбора задач: `ids` — явный список id'ов;
 * `filter` — по темам/рейтингу + лимит. Переключение режима сбрасывает
 * выбор (чтобы старое состояние не протекало).
 *
 * Вынесено из `StepEditor.tsx` без изменения поведения.
 */

interface PuzzleFieldsProps {
  payload: Extract<StepPayload, { type: 'puzzle' }>;
  onChange: (p: StepPayload) => void;
}

export function PuzzleFields({ payload, onChange }: PuzzleFieldsProps) {
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
