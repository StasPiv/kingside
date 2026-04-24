import { useTranslation } from 'react-i18next';
import type { StepPayload } from '@kingside/shared';

/**
 * `EndgameDrillFields` — форма редактирования `EndgameDrillStepPayload`
 * (KS-1849 / FE-R1). FEN стартовой позиции + сторона ученика +
 * сила движка (Skill Level 0..20) + условие победы + лимит ходов +
 * флаг подсказок. Вынесено из `StepEditor.tsx`.
 */

interface EndgameDrillFieldsProps {
  payload: Extract<StepPayload, { type: 'endgame_drill' }>;
  onChange: (p: StepPayload) => void;
}

export function EndgameDrillFields({
  payload,
  onChange,
}: EndgameDrillFieldsProps) {
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
