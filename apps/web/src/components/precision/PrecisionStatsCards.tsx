import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';

/**
 * KS-2744 / ADR-057 §3 — top-блок из 4 агрегированных карточек точности
 * (точность ходов / удержано-упущено / WDL-leak / до первой ошибки).
 *
 * Раньше блок жил inline в `PrecisionPage` (KS-2719). По ADR-057 §3
 * переехал в `/precision/stats`; вынесен в отдельный компонент, чтобы
 * избежать дублирования логики и упростить тесты.
 *
 * Источник — `GET /precision/stats/me` (бэкенд KS-2718 / ADR-056 §2.1).
 * Контракт держим локально — на момент извлечения PrecisionPage
 * использует упрощённую форму с nullable-полями (graceful 404-fallback
 * во время выкатки бэкенда). Унификация с `@kingside/shared` —
 * отдельной задачей, чтобы не ломать F2.
 *
 * Состояния:
 *   - loading: сетка показывается с placeholder (тот же UX, что был
 *              на /precision до переезда — не моргает skeleton'ом, т.к.
 *              блок небольшой и грузится быстро).
 *   - empty (totalAttempts=0 или 404): placeholder «Сыграй первую попытку».
 *   - ready: 4 карточки.
 *
 * # DOM (совместим с прежним из PrecisionPage)
 *   <div class="precision-stats" data-testid="precision-stats"
 *        data-state="ready|empty"
 *        data-attempts="N" data-preserved="N">
 *     <p data-testid="precision-stats-placeholder">…</p>    // если empty
 *     <div data-testid="precision-stats-accuracy">…</div>
 *     <div data-testid="precision-stats-preserved">…</div>
 *     <div data-testid="precision-stats-leak">…</div>
 *     <div data-testid="precision-stats-first-mistake">…</div>
 *   </div>
 */

export interface PrecisionStatsCardsResponse {
  totalAttempts: number;
  preservedCount: number;
  avgAccuracyPercent: number | null;
  avgWdlLeakPerMove: number | null;
  avgHalfMovesUntilFirstMistake: number | null;
}

export interface PrecisionStatsCardsProps {
  /** DI для тестов: подменяет вызов `api.get('/precision/stats/me')`. */
  fetcher?: () => Promise<PrecisionStatsCardsResponse | null>;
}

export function PrecisionStatsCards({ fetcher }: PrecisionStatsCardsProps = {}) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<PrecisionStatsCardsResponse | null>(null);

  const doFetch = useCallback(async () => {
    const get =
      fetcher ??
      (() =>
        api
          .get<PrecisionStatsCardsResponse>('/precision/stats/me')
          .catch(() => null));
    try {
      const data = await get();
      setStats(data);
    } catch {
      setStats(null);
    }
  }, [fetcher]);

  useEffect(() => {
    void doFetch();
  }, [doFetch]);

  const hasData = stats != null && stats.totalAttempts > 0;

  const fmtAccuracy = (p: number | null): string =>
    p == null ? t('precision.stats.noData', '—') : `${Math.round(p)}%`;
  const fmtLeak = (l: number | null): string => {
    if (l == null) return t('precision.stats.noData', '—');
    // ADR-056 §2.1: avgWdlLeakPerMove — доли (0..1) среднего снижения
    // WDL_user за полуход. На UI крупная цифра в % (понятнее «4%»
    // чем «0.04»).
    return `${(l * 100).toFixed(1)}%`;
  };
  const fmtFirstMistake = (n: number | null): string =>
    n == null ? t('precision.stats.noData', '—') : n.toFixed(1);

  return (
    <div
      className="precision-stats"
      data-testid="precision-stats"
      data-state={hasData ? 'ready' : 'empty'}
      data-attempts={String(stats?.totalAttempts ?? 0)}
      data-preserved={String(stats?.preservedCount ?? 0)}
    >
      {!hasData && (
        <p
          className="precision-stats__placeholder"
          data-testid="precision-stats-placeholder"
        >
          {t('precision.stats.placeholder', 'Play your first attempt')}
        </p>
      )}
      {hasData && stats && (
        <>
          <div
            className="precision-stats__cell"
            data-testid="precision-stats-accuracy"
          >
            <div className="precision-stats__value">
              {fmtAccuracy(stats.avgAccuracyPercent)}
            </div>
            <div className="precision-stats__label">
              {t('precision.stats.avgAccuracy', 'Move accuracy')}
            </div>
            <div className="precision-stats__hint">
              {t(
                'precision.stats.avgAccuracyHint',
                'Average accuracy across all attempts',
              )}
            </div>
          </div>
          <div
            className="precision-stats__cell"
            data-testid="precision-stats-preserved"
          >
            <div className="precision-stats__value">
              {stats.preservedCount} /{' '}
              {Math.max(0, stats.totalAttempts - stats.preservedCount)}
            </div>
            <div className="precision-stats__label">
              {t('precision.stats.preservedRatio', 'Preserved / Lost')}
            </div>
            <div className="precision-stats__hint">
              {stats.totalAttempts > 0
                ? `${Math.round((stats.preservedCount / stats.totalAttempts) * 100)}%`
                : t('precision.stats.noData', '—')}
            </div>
          </div>
          <div
            className="precision-stats__cell"
            data-testid="precision-stats-leak"
          >
            <div className="precision-stats__value">
              {fmtLeak(stats.avgWdlLeakPerMove)}
            </div>
            <div className="precision-stats__label">
              {t('precision.stats.wdlLeak', 'WDL leak per move')}
            </div>
            <div className="precision-stats__hint">
              {t(
                'precision.stats.wdlLeakHint',
                'Average drop in winning chances per half-move',
              )}
            </div>
          </div>
          <div
            className="precision-stats__cell"
            data-testid="precision-stats-first-mistake"
          >
            <div className="precision-stats__value">
              {fmtFirstMistake(stats.avgHalfMovesUntilFirstMistake)}
            </div>
            <div className="precision-stats__label">
              {t('precision.stats.untilFirstMistake', 'Until first mistake')}
            </div>
            <div className="precision-stats__hint">
              {t(
                'precision.stats.untilFirstMistakeHint',
                'Average number of accurate moves before the first inaccuracy',
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
