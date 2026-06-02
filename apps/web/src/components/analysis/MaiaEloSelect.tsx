/**
 * KS-3588 (ADR-097). Compact-селект ELO для Maia в шапке engine-panel.
 *
 * Props:
 *  - `value` — текущий ELO (1100..2400, шаг 100).
 *  - `onChange` — setter, clamp/store делает hook `useMaiaAnalysis`.
 *  - `status` — статус Maia. При `error` рисуем иконку-предупреждение
 *    с tooltip («Maia недоступна»). При `loading` — без визуального
 *    индикатора (UI не дёргается на каждую смену fen).
 */
import { useTranslation } from 'react-i18next';

import {
  MAIA_ELO_OPTIONS,
  type MaiaAnalysisStatus,
} from '../../hooks/useMaiaAnalysis';

export interface MaiaEloSelectProps {
  value: number;
  onChange: (elo: number) => void;
  status: MaiaAnalysisStatus;
}

export function MaiaEloSelect({ value, onChange, status }: MaiaEloSelectProps) {
  const { t } = useTranslation();
  const isError = status === 'error';

  return (
    <span
      className="maia-elo-select"
      data-testid="maia-elo-select"
      data-status={status}
    >
      <span className="maia-elo-select__label">
        {t('analysis.maia.elo', 'Maia')}
      </span>
      <select
        className="maia-elo-select__select"
        data-testid="maia-elo-select-input"
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      >
        {MAIA_ELO_OPTIONS.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
      {isError && (
        <span
          className="maia-elo-select__warning"
          data-testid="maia-elo-select-warning"
          title={t('analysis.maia.unavailable', 'Maia unavailable')}
          aria-label={t('analysis.maia.unavailable', 'Maia unavailable')}
          role="img"
        >
          ⚠
        </span>
      )}
    </span>
  );
}
