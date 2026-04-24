import { useTranslation } from 'react-i18next';
import type { StepPayload } from '@kingside/shared';

/**
 * `VideoFields` — форма редактирования `VideoStepPayload`
 * (KS-1849 / FE-R1). YouTube/Vimeo URL + опциональный i18n-ключ
 * заголовка. Вынесено из `StepEditor.tsx`.
 */

interface VideoFieldsProps {
  payload: Extract<StepPayload, { type: 'video' }>;
  onChange: (p: StepPayload) => void;
}

export function VideoFields({ payload, onChange }: VideoFieldsProps) {
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
