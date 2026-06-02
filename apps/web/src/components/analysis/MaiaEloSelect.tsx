/**
 * KS-3588 (ADR-097) + KS-3590. Compact-селект ELO для Maia в шапке
 * engine-panel.
 *
 * KS-3590: классы синхронизированы с CSS-контрактом layout-агента
 * (KS-3589, `apps/web/src/styles/engine.css` строки 632+):
 *   .maia-elo-controls          — inline-flex обёртка;
 *   .maia-elo-controls__label   — текст «Maia» слева;
 *   .maia-elo-select            — сам `<select>` (appearance:none + svg
 *                                 chevron, hover/focus, disabled);
 *   .maia-elo-warning           — иконка-предупреждение при `status==='error'`.
 *
 * При `status === 'loading'` визуального индикатора нет (UI не дёргается
 * на каждую смену fen) — на `<select>` достаточно opacity-стейта через
 * `disabled`/`data-status` если потребуется в layout.
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
      className="maia-elo-controls"
      data-testid="maia-elo-select"
      data-status={status}
    >
      <span className="maia-elo-controls__label">
        {t('analysis.maia.elo', 'Maia')}
      </span>
      <select
        className="maia-elo-select"
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
          className="maia-elo-warning"
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
