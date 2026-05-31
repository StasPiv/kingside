import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GuessStatsResponse } from '@kingside/shared';
import { api } from '../../api';

/**
 * KS-3510 (ADR-093 §3.1) — 4 топ-метрики из `GuessStatsResponse`:
 *   1. avgUserAccuracy (Move accuracy)
 *   2. winsVsPlayer / totalSessions (Wins vs player)
 *   3. bestStreak (Best streak)
 *   4. avgStars (Avg stars)
 *
 * Источник — `GET /guess/stats/me` (B-guess, KS-3508). При 0 сессий
 * показываем placeholder без карточек.
 */
export interface GuessStatsCardsProps {
  fetcher?: () => Promise<GuessStatsResponse | null>;
}

export function GuessStatsCards({ fetcher }: GuessStatsCardsProps = {}) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<GuessStatsResponse | null>(null);

  const doFetch = useCallback(async () => {
    const get =
      fetcher ??
      (() =>
        api.get<GuessStatsResponse>('/guess/stats/me').catch(() => null));
    const data = await get();
    setStats(data);
  }, [fetcher]);

  useEffect(() => {
    void doFetch();
  }, [doFetch]);

  const hasData = stats != null && stats.totalSessions > 0;

  const fmtPct = (p: number | null): string =>
    p == null ? t('guess.stats.noData', '—') : `${Math.round(p)}%`;
  const fmtStars = (s: number | null): string =>
    s == null ? t('guess.stats.noData', '—') : `${s.toFixed(1)}/5`;

  return (
    <div
      className="guess-stats"
      data-testid="guess-stats"
      data-state={hasData ? 'ready' : 'empty'}
      data-sessions={String(stats?.totalSessions ?? 0)}
    >
      {!hasData && (
        <p
          className="guess-stats__placeholder"
          data-testid="guess-stats-placeholder"
        >
          {t('guess.stats.placeholder', 'Play your first guess session')}
        </p>
      )}
      {hasData && stats && (
        <>
          <div
            className="guess-stats__cell"
            data-testid="guess-stats-accuracy"
          >
            <div className="guess-stats__value">
              {fmtPct(stats.avgUserAccuracy)}
            </div>
            <div className="guess-stats__label">
              {t('guess.stats.avgAccuracy', 'Move accuracy')}
            </div>
            <div className="guess-stats__hint">
              {t(
                'guess.stats.avgAccuracyHint',
                'Average accuracy across finished sessions',
              )}
            </div>
          </div>
          <div
            className="guess-stats__cell"
            data-testid="guess-stats-wins"
          >
            <div className="guess-stats__value">
              {stats.winsVsPlayer} / {stats.totalSessions}
            </div>
            <div className="guess-stats__label">
              {t('guess.stats.winsVsPlayer', 'Wins vs player')}
            </div>
            <div className="guess-stats__hint">
              {stats.totalSessions > 0
                ? `${Math.round((stats.winsVsPlayer / stats.totalSessions) * 100)}%`
                : t('guess.stats.noData', '—')}
            </div>
          </div>
          <div
            className="guess-stats__cell"
            data-testid="guess-stats-best-streak"
          >
            <div className="guess-stats__value">{stats.bestStreak}</div>
            <div className="guess-stats__label">
              {t('guess.stats.bestStreak', 'Best streak')}
            </div>
            <div className="guess-stats__hint">
              {t(
                'guess.stats.bestStreakHint',
                'Longest streak of best/equal moves',
              )}
            </div>
          </div>
          <div
            className="guess-stats__cell"
            data-testid="guess-stats-avg-stars"
          >
            <div className="guess-stats__value">
              {fmtStars(stats.avgStars)}
            </div>
            <div className="guess-stats__label">
              {t('guess.stats.avgStars', 'Avg stars')}
            </div>
            <div className="guess-stats__hint">
              {t(
                'guess.stats.avgStarsHint',
                'Average session rating (out of 5)',
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
