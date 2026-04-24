import { useTranslation } from 'react-i18next';
import type { StepPayload } from '@kingside/shared';

import { MemoChessboard } from '../../../MemoChessboard';

/**
 * `PositionFields` — форма редактирования `PositionStepPayload`
 * (KS-1849 / FE-R1). FEN + ожидаемые ходы (UCI, через запятую) +
 * ориентация доски. Вынесено из `StepEditor.tsx`.
 */

interface PositionFieldsProps {
  payload: Extract<StepPayload, { type: 'position' }>;
  onChange: (p: StepPayload) => void;
}

export function PositionFields({ payload, onChange }: PositionFieldsProps) {
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
