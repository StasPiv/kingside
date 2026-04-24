import { useTranslation } from 'react-i18next';
import type { StepPayload } from '@kingside/shared';

/**
 * `GameReviewFields` — форма редактирования `GameReviewStepPayload`
 * (KS-1849 / FE-R1). Принимает либо `gameId` (ссылка на партию в БД),
 * либо `pgn` — XOR проверяется на backend. Вынесено из `StepEditor.tsx`.
 */

interface GameReviewFieldsProps {
  payload: Extract<StepPayload, { type: 'game_review' }>;
  onChange: (p: StepPayload) => void;
}

export function GameReviewFields({ payload, onChange }: GameReviewFieldsProps) {
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
