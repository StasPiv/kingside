/**
 * KS-3584 (ADR-096). Maia-блок в engine-panel: top-5 человеческих
 * ходов на выбранном ELO, обновляется на каждой новой позиции.
 *
 * Структура DOM (стили — отдельная задача [B. layout] / KS-3585):
 *   .maia-section
 *     .maia-section-header  (заголовок + select ELO)
 *     .maia-lines           (список .maia-line × до 5)
 *     .maia-line--best      (top-1 жирностью)
 *
 * Состояния:
 *  - idle/loading: «Загружаем Maia…».
 *  - error: «Не удалось загрузить Maia» + кнопка «Попробовать снова».
 *  - ready: список ходов. При re-fetch (status==='loading' и lines
 *    непустые) — opacity 0.5 на старых данных, см. ADR-096 §5.5.
 */
import { useTranslation } from 'react-i18next';

import type { User } from '@kingside/shared';
import {
  MAIA_ELO_OPTIONS,
  useMaiaAnalysis,
} from '../../hooks/useMaiaAnalysis';
import type { MaiaSinglePredictionEngine } from '../../hooks/useMaiaAnalysis';
import { uciToSan } from '../../lib/maia/uciToSan';

export interface MaiaAnalysisSectionProps {
  fen: string;
  /**
   * KS-3584: пользовательский профиль (для подбора initial ELO). Опц.,
   * пробрасывается из `AnalysisPage` через `AnalysisSidebar`. Если не
   * передан — initial ELO берётся из localStorage / 1500 (fallback).
   * Намеренно НЕ читаем `useAuth()` внутри: это сломало бы существующие
   * unit-тесты AnalysisSidebar/AnalysisPage, в которых AuthContext
   * замокан без `user` или вообще без обёртки в `AuthProvider`.
   */
  user?: Pick<
    User,
    | 'ratingBlitz'
    | 'ratingRapid'
    | 'ratingClassical'
    | 'ratingBullet'
    | 'ratingPuzzle'
  > | null;
  /** Тестовый engine — обходит worker (для unit-тестов). */
  engine?: MaiaSinglePredictionEngine;
}

function formatProb(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

export function MaiaAnalysisSection({
  fen,
  user,
  engine,
}: MaiaAnalysisSectionProps) {
  const { t } = useTranslation();
  const { elo, setElo, lines, status, retry } = useMaiaAnalysis({
    fen,
    user: user ?? null,
    engine,
  });

  // Сохраняем последний непустой набор линий чтобы при «в полёте»
  // обновлении не было прыжка в пустой список — показываем старые с
  // opacity (см. ADR-096 §5.5).
  const showStaleHint = status === 'loading' && lines.length > 0;

  return (
    <div
      className="maia-section"
      data-testid="maia-section"
      data-status={status}
    >
      <div className="maia-section-header">
        <span className="maia-section-title">
          {t('analysis.maia.title', 'Human moves (Maia)')}
        </span>
        <label className="maia-section-elo">
          <span className="maia-section-elo-label">
            {t('analysis.maia.elo', 'ELO')}
          </span>
          <select
            className="maia-section-elo-select"
            data-testid="maia-section-elo-select"
            value={elo}
            onChange={(e) => setElo(Number(e.currentTarget.value))}
          >
            {MAIA_ELO_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>

      {status === 'error' ? (
        <div className="maia-section-error" data-testid="maia-section-error">
          <span className="maia-section-error-text">
            {t('analysis.maia.error', 'Failed to load Maia')}
          </span>
          <button
            type="button"
            className="maia-section-retry"
            data-testid="maia-section-retry"
            onClick={retry}
          >
            {t('analysis.maia.retry', 'Try again')}
          </button>
        </div>
      ) : (status === 'idle' || status === 'loading') && lines.length === 0 ? (
        <div className="maia-section-loading" data-testid="maia-section-loading">
          {t('analysis.maia.loading', 'Loading Maia…')}
        </div>
      ) : (
        <ul
          className={`maia-lines${showStaleHint ? ' maia-lines--stale' : ''}`}
          data-testid="maia-lines"
          data-stale={showStaleHint ? 'true' : 'false'}
        >
          {lines.map((m, i) => (
            <li
              key={m.move}
              className={`maia-line${i === 0 ? ' maia-line--best' : ''}`}
              data-testid={`maia-line-${i}`}
            >
              <span className="maia-line-prob">{formatProb(m.probability)}</span>
              <span className="maia-line-sep">{' │ '}</span>
              <span className="maia-line-san">{uciToSan(fen, m.move)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
