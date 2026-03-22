import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';

type Props = {
  onApply: (fen: string) => void;
  onClose: () => void;
};

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const EMPTY_FEN = '8/8/8/8/8/8/8/8 w - - 0 1';

function validateFen(fen: string): string | null {
  try {
    new Chess(fen);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid FEN';
  }
}

export function SetPositionModal({ onApply, onClose }: Props) {
  const { t } = useTranslation();
  const [fenInput, setFenInput] = useState(INITIAL_FEN);
  const [error, setError] = useState<string | null>(null);

  const handleApply = () => {
    const trimmed = fenInput.trim();
    if (!trimmed) {
      setError('FEN is required');
      return;
    }
    const err = validateFen(trimmed);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    onApply(trimmed);
  };

  return (
    <div className="set-position-overlay" onClick={onClose}>
      <div className="set-position-modal" onClick={(e) => e.stopPropagation()}>
        <div className="set-position-header">
          <h3>{t('position.title', 'Set Position')}</h3>
          <button className="set-position-close" onClick={onClose}>✕</button>
        </div>

        <div className="set-position-body">
          <label className="set-position-label">{t('position.fenLabel', 'FEN notation:')}</label>
          <input
            type="text"
            className="set-position-input"
            value={fenInput}
            onChange={(e) => { setFenInput(e.target.value); setError(null); }}
            placeholder="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
            spellCheck={false}
          />

          {error && <div className="set-position-error">{error}</div>}

          <div className="set-position-presets">
            <button
              className="set-position-preset"
              onClick={() => setFenInput(INITIAL_FEN)}
            >
              {t('position.startPos', 'Starting Position')}
            </button>
            <button
              className="set-position-preset"
              onClick={() => setFenInput(EMPTY_FEN)}
            >
              {t('position.emptyBoard', 'Empty Board')}
            </button>
            <button
              className="set-position-preset"
              onClick={async () => {
                try {
                  const text = await navigator.clipboard.readText();
                  if (text.trim()) setFenInput(text.trim());
                } catch { /* clipboard not available */ }
              }}
            >
              {t('position.paste', 'Paste from Clipboard')}
            </button>
          </div>

          <div className="set-position-actions">
            <button className="set-position-cancel" onClick={onClose}>
              {t('common.cancel', 'Cancel')}
            </button>
            <button className="set-position-apply" onClick={handleApply}>
              {t('position.apply', 'Apply')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
