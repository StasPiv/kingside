import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const TIME_PRESETS = [
  { label: '1+0', minutes: 1, increment: 0 },
  { label: '3+0', minutes: 3, increment: 0 },
  { label: '3+2', minutes: 3, increment: 2 },
  { label: '5+0', minutes: 5, increment: 0 },
  { label: '5+3', minutes: 5, increment: 3 },
  { label: '10+0', minutes: 10, increment: 0 },
  { label: '10+5', minutes: 10, increment: 5 },
  { label: '15+10', minutes: 15, increment: 10 },
];

type Props = {
  targetUsername: string;
  onSend: (timeInitial: number, increment: number) => void;
  onClose: () => void;
  waiting?: boolean;
  error?: string | null;
};

export function ChallengeModal({ targetUsername, onSend, onClose, waiting, error }: Props) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<{ minutes: number; increment: number }>({ minutes: 5, increment: 0 });

  return (
    <div className="challenge-modal-overlay" onClick={onClose}>
      <div className="challenge-modal" onClick={(e) => e.stopPropagation()}>
        <div className="challenge-modal__header">
          <h3>{t('challenge.title', 'Challenge')} {targetUsername}</h3>
          <button className="challenge-modal__close" onClick={onClose}>✕</button>
        </div>

        <div className="challenge-modal__body">
          <p className="challenge-modal__label">{t('challenge.selectTime', 'Select time control:')}</p>
          <div className="challenge-modal__presets">
            {TIME_PRESETS.map((p) => (
              <button
                key={p.label}
                className={`challenge-preset-btn${selected.minutes === p.minutes && selected.increment === p.increment ? ' active' : ''}`}
                onClick={() => setSelected({ minutes: p.minutes, increment: p.increment })}
                disabled={waiting}
              >
                {p.label}
              </button>
            ))}
          </div>

          {error && <div className="challenge-modal__error">{error}</div>}

          <div className="challenge-modal__actions">
            {waiting ? (
              <button className="challenge-send-btn" disabled>
                {t('challenge.waiting', 'Waiting for response...')}
              </button>
            ) : (
              <button
                className="challenge-send-btn"
                onClick={() => onSend(selected.minutes * 60, selected.increment)}
              >
                {t('challenge.send', 'Send Challenge')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
