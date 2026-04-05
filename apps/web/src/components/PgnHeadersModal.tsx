import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

type Props = {
  headers: Record<string, string>;
  onApply: (headers: Record<string, string>) => void;
  onClose: () => void;
};

const RESULT_OPTIONS = ['*', '1-0', '0-1', '1/2-1/2'];

export function PgnHeadersModal({ headers, onApply, onClose }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    White: headers['White'] ?? '',
    Black: headers['Black'] ?? '',
    WhiteElo: headers['WhiteElo'] ?? '',
    BlackElo: headers['BlackElo'] ?? '',
    Result: headers['Result'] ?? '*',
    Event: headers['Event'] ?? '',
    Site: headers['Site'] ?? '',
    Date: headers['Date'] ?? '',
    Round: headers['Round'] ?? '',
  });

  const set = useCallback((key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleApply = useCallback(() => {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(form)) {
      const trimmed = value.trim();
      if (trimmed) result[key] = trimmed;
    }
    onApply(result);
    onClose();
  }, [form, onApply, onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="pgn-headers-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pgn-headers-modal__header">
          <h3>{t('analysis.gameInfo', 'Game Info')}</h3>
          <button className="pgn-headers-modal__close" onClick={onClose}>&times;</button>
        </div>

        <div className="pgn-headers-modal__body">
          <div className="pgn-headers-modal__row pgn-headers-modal__row--players">
            <label>
              <span>{t('analysis.white', 'White')}</span>
              <input
                type="text"
                value={form.White}
                onChange={(e) => set('White', e.target.value)}
                placeholder={t('analysis.playerName', 'Player name')}
              />
            </label>
            <label>
              <span>{t('analysis.whiteElo', 'Elo')}</span>
              <input
                type="text"
                value={form.WhiteElo}
                onChange={(e) => set('WhiteElo', e.target.value)}
                placeholder="1500"
                className="pgn-headers-modal__elo"
              />
            </label>
          </div>

          <div className="pgn-headers-modal__row pgn-headers-modal__row--players">
            <label>
              <span>{t('analysis.black', 'Black')}</span>
              <input
                type="text"
                value={form.Black}
                onChange={(e) => set('Black', e.target.value)}
                placeholder={t('analysis.playerName', 'Player name')}
              />
            </label>
            <label>
              <span>{t('analysis.blackElo', 'Elo')}</span>
              <input
                type="text"
                value={form.BlackElo}
                onChange={(e) => set('BlackElo', e.target.value)}
                placeholder="1500"
                className="pgn-headers-modal__elo"
              />
            </label>
          </div>

          <div className="pgn-headers-modal__row">
            <label>
              <span>{t('analysis.result', 'Result')}</span>
              <select value={form.Result} onChange={(e) => set('Result', e.target.value)}>
                {RESULT_OPTIONS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
          </div>

          <details className="pgn-headers-modal__extra">
            <summary>{t('analysis.moreFields', 'More fields')}</summary>
            <div className="pgn-headers-modal__row">
              <label>
                <span>{t('analysis.event', 'Event')}</span>
                <input
                  type="text"
                  value={form.Event}
                  onChange={(e) => set('Event', e.target.value)}
                  placeholder="Tournament"
                />
              </label>
            </div>
            <div className="pgn-headers-modal__row">
              <label>
                <span>{t('analysis.site', 'Site')}</span>
                <input
                  type="text"
                  value={form.Site}
                  onChange={(e) => set('Site', e.target.value)}
                  placeholder="City"
                />
              </label>
            </div>
            <div className="pgn-headers-modal__row pgn-headers-modal__row--half">
              <label>
                <span>{t('analysis.date', 'Date')}</span>
                <input
                  type="text"
                  value={form.Date}
                  onChange={(e) => set('Date', e.target.value)}
                  placeholder="2026.04.05"
                />
              </label>
              <label>
                <span>{t('analysis.round', 'Round')}</span>
                <input
                  type="text"
                  value={form.Round}
                  onChange={(e) => set('Round', e.target.value)}
                  placeholder="1"
                />
              </label>
            </div>
          </details>
        </div>

        <div className="pgn-headers-modal__footer">
          <button className="pgn-headers-modal__cancel" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button className="pgn-headers-modal__apply" onClick={handleApply}>
            {t('common.apply', 'Apply')}
          </button>
        </div>
      </div>
    </div>
  );
}
