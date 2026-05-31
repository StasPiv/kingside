import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BlindBoardStatsResponse } from '@kingside/shared';
import { api } from '../../api';

/**
 * KS-3511 (ADR-093 §4.1) — 4 топ-карточки:
 *   1. bestStreak (Best streak)
 *   2. currentStreak (Current streak)
 *   3. maxLevelReached (Max level)
 *   4. avgRoundsPerSession (Avg rounds)
 *
 * Источник — `GET /blind-board/stats/me`.
 */
export interface BlindBoardStatsCardsProps {
  fetcher?: () => Promise<BlindBoardStatsResponse | null>;
}

export function BlindBoardStatsCards({
  fetcher,
}: BlindBoardStatsCardsProps = {}) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<BlindBoardStatsResponse | null>(null);

  const doFetch = useCallback(async () => {
    const get =
      fetcher ??
      (() =>
        api
          .get<BlindBoardStatsResponse>('/blind-board/stats/me')
          .catch(() => null));
    setStats(await get());
  }, [fetcher]);

  useEffect(() => {
    void doFetch();
  }, [doFetch]);

  const hasData = stats != null && stats.totalSessions > 0;

  const fmtRounds = (n: number | null): string =>
    n == null ? t('blindBoard.stats.noData', '—') : n.toFixed(1);

  return (
    <div
      className="blind-board-stats"
      data-testid="blind-board-stats"
      data-state={hasData ? 'ready' : 'empty'}
      data-sessions={String(stats?.totalSessions ?? 0)}
    >
      {!hasData && (
        <p
          className="blind-board-stats__placeholder"
          data-testid="blind-board-stats-placeholder"
        >
          {t(
            'blindBoard.stats.placeholder',
            'Play your first blind-board session',
          )}
        </p>
      )}
      {hasData && stats && (
        <>
          <div
            className="blind-board-stats__cell"
            data-testid="blind-board-stats-best-streak"
          >
            <div className="blind-board-stats__value">{stats.bestStreak}</div>
            <div className="blind-board-stats__label">
              {t('blindBoard.stats.bestStreak', 'Best streak')}
            </div>
            <div className="blind-board-stats__hint">
              {t(
                'blindBoard.stats.bestStreakHint',
                'Longest streak of correct answers',
              )}
            </div>
          </div>
          <div
            className="blind-board-stats__cell"
            data-testid="blind-board-stats-current-streak"
          >
            <div className="blind-board-stats__value">
              {stats.currentStreak}
            </div>
            <div className="blind-board-stats__label">
              {t('blindBoard.stats.currentStreak', 'Current streak')}
            </div>
            <div className="blind-board-stats__hint">
              {t(
                'blindBoard.stats.currentStreakHint',
                'Last session streak — keep going!',
              )}
            </div>
          </div>
          <div
            className="blind-board-stats__cell"
            data-testid="blind-board-stats-max-level"
          >
            <div className="blind-board-stats__value">
              L{stats.maxLevelReached}
            </div>
            <div className="blind-board-stats__label">
              {t('blindBoard.stats.maxLevel', 'Max level')}
            </div>
            <div className="blind-board-stats__hint">
              {t(
                'blindBoard.stats.maxLevelHint',
                'Highest level reached so far',
              )}
            </div>
          </div>
          <div
            className="blind-board-stats__cell"
            data-testid="blind-board-stats-avg-rounds"
          >
            <div className="blind-board-stats__value">
              {fmtRounds(stats.avgRoundsPerSession)}
            </div>
            <div className="blind-board-stats__label">
              {t('blindBoard.stats.avgRounds', 'Avg rounds')}
            </div>
            <div className="blind-board-stats__hint">
              {t(
                'blindBoard.stats.avgRoundsHint',
                'Average rounds per session',
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
