import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TacticDrillSprintScoreItem } from '@kingside/shared';

import { api } from '../api';
import { useAuth } from '../context/AuthContext';

/**
 * KS-2242 (ADR-035 §5.5, Drills E4) — лидерборд sprint-режима.
 *
 * Образец — `PuzzleRushLeaderboardPage`. Отличия:
 *   - 3 фильтра вместо 1: длительность (3min/5min) × drill-set
 *     (mixed/overview/pattern/calculation) × период (day/week/allTime).
 *   - mode-string собирается на клиенте из duration+set:
 *     `<duration>min-<set>`. Пример: `3min-mixed`, `5min-overview`.
 *     Backend хранит результаты по mode-строке; разные комбинации —
 *     отдельные таблицы.
 *
 * # API
 *   GET /tactic-drill/sprint/leaderboard?mode=<mode>&period=<period>
 *   → { mode, entries: TacticDrillSprintScoreItem[] }
 *
 * # Контракт DOM
 *
 *   <div class="drill-leaderboard" data-testid="drill-leaderboard"
 *        data-mode="<mode>" data-period="<period>">
 *     <h1>…</h1>
 *     <div class="drill-leaderboard__filters">
 *       <fieldset data-testid="drill-leaderboard-duration">…</fieldset>
 *       <fieldset data-testid="drill-leaderboard-set">…</fieldset>
 *       <fieldset data-testid="drill-leaderboard-period">…</fieldset>
 *     </div>
 *     <table class="drill-leaderboard__table">…</table>
 *     <Link>…</Link>
 *   </div>
 */

type Duration = '3' | '5';
type DrillSet = 'mixed' | 'overview' | 'pattern' | 'calculation';
type Period = 'day' | 'week' | 'allTime';

interface LeaderboardResponse {
  mode: string;
  entries: TacticDrillSprintScoreItem[];
}

const DURATIONS: Duration[] = ['3', '5'];
const SETS: DrillSet[] = ['mixed', 'overview', 'pattern', 'calculation'];
const PERIODS: Period[] = ['day', 'week', 'allTime'];

function buildMode(d: Duration, s: DrillSet): string {
  return `${d}min-${s}`;
}

function formatDate(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function formatAccuracy(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0%';
  return `${Math.round(v * 100)}%`;
}

export function DrillLeaderboardPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const [duration, setDuration] = useState<Duration>('3');
  const [drillSet, setDrillSet] = useState<DrillSet>('mixed');
  const [period, setPeriod] = useState<Period>('allTime');
  const [entries, setEntries] = useState<TacticDrillSprintScoreItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const mode = useMemo(() => buildMode(duration, drillSet), [duration, drillSet]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<LeaderboardResponse>(
        `/tactic-drill/sprint/leaderboard?mode=${encodeURIComponent(mode)}&period=${encodeURIComponent(period)}`,
      )
      .then(
        (resp) => {
          if (cancelled) return;
          setEntries(resp.entries ?? []);
          setLoading(false);
        },
        () => {
          if (cancelled) return;
          setError('loadFailed');
          setLoading(false);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [mode, period]);

  return (
    <div
      className="drill-leaderboard"
      data-testid="drill-leaderboard"
      data-mode={mode}
      data-period={period}
    >
      <header className="drill-leaderboard__header">
        <h1 className="drill-leaderboard__title">
          {t('drills.sprint.leaderboard.heading', 'Sprint leaderboard')}
        </h1>
      </header>

      <div className="drill-leaderboard__filters">
        <fieldset
          className="drill-leaderboard__filter"
          data-testid="drill-leaderboard-duration"
        >
          <legend>{t('drills.sprint.leaderboard.duration', 'Duration')}</legend>
          {DURATIONS.map((d) => (
            <label key={d} className="drill-leaderboard__option">
              <input
                type="radio"
                name="drill-lb-duration"
                value={d}
                checked={duration === d}
                onChange={() => setDuration(d)}
                data-testid={`drill-leaderboard-duration-${d}`}
              />{' '}
              {d === '3'
                ? t('drills.sprint.leaderboard.duration3', '3 min')
                : t('drills.sprint.leaderboard.duration5', '5 min')}
            </label>
          ))}
        </fieldset>

        <fieldset
          className="drill-leaderboard__filter"
          data-testid="drill-leaderboard-set"
        >
          <legend>{t('drills.sprint.leaderboard.drillSet', 'Drill set')}</legend>
          {SETS.map((s) => (
            <label key={s} className="drill-leaderboard__option">
              <input
                type="radio"
                name="drill-lb-set"
                value={s}
                checked={drillSet === s}
                onChange={() => setDrillSet(s)}
                data-testid={`drill-leaderboard-set-${s}`}
              />{' '}
              {t(`drills.sprint.leaderboard.set.${s}`)}
            </label>
          ))}
        </fieldset>

        <fieldset
          className="drill-leaderboard__filter"
          data-testid="drill-leaderboard-period"
        >
          <legend>{t('drills.sprint.leaderboard.period', 'Period')}</legend>
          {PERIODS.map((p) => (
            <label key={p} className="drill-leaderboard__option">
              <input
                type="radio"
                name="drill-lb-period"
                value={p}
                checked={period === p}
                onChange={() => setPeriod(p)}
                data-testid={`drill-leaderboard-period-${p}`}
              />{' '}
              {p === 'day'
                ? t('drills.sprint.leaderboard.periodDay', 'Today')
                : p === 'week'
                ? t('drills.sprint.leaderboard.periodWeek', 'This week')
                : t('drills.sprint.leaderboard.periodAllTime', 'All time')}
            </label>
          ))}
        </fieldset>
      </div>

      {error && (
        <div
          className="drill-leaderboard__error"
          data-testid="drill-leaderboard-error"
          role="alert"
        >
          {t('drills.sprint.leaderboard.loadFailed', 'Could not load leaderboard.')}
        </div>
      )}

      {loading ? (
        <div
          className="drill-leaderboard__loading"
          data-testid="drill-leaderboard-loading"
        >
          {t('drills.loading', 'Loading…')}
        </div>
      ) : entries.length === 0 ? (
        <div
          className="drill-leaderboard__empty"
          data-testid="drill-leaderboard-empty"
        >
          {t('drills.sprint.leaderboard.empty', 'No scores yet.')}
        </div>
      ) : (
        <table
          className="drill-leaderboard__table"
          data-testid="drill-leaderboard-table"
        >
          <thead>
            <tr>
              <th>{t('drills.sprint.leaderboard.col.rank', '#')}</th>
              <th>{t('drills.sprint.leaderboard.col.player', 'Player')}</th>
              <th>{t('drills.sprint.leaderboard.col.score', 'Score')}</th>
              <th>{t('drills.sprint.leaderboard.col.accuracy', 'Accuracy')}</th>
              <th>{t('drills.sprint.leaderboard.col.date', 'Date')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => {
              const isCurrent = !!user && entry.userId === user.id;
              return (
                <tr
                  key={`${entry.userId}-${index}`}
                  className={
                    isCurrent
                      ? 'drill-leaderboard__row drill-leaderboard__row--current'
                      : 'drill-leaderboard__row'
                  }
                  data-current={isCurrent ? 'true' : 'false'}
                  data-user-id={entry.userId}
                >
                  <td>{index + 1}</td>
                  <td>{entry.username}</td>
                  <td>{entry.score}</td>
                  <td>{formatAccuracy(entry.accuracy)}</td>
                  <td>{formatDate(entry.createdAt, i18n.language)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <Link
        to="/drills/sprint"
        className="drill-leaderboard__back"
        data-testid="drill-leaderboard-back"
      >
        ← {t('drills.sprint.leaderboard.back', 'Back to sprint setup')}
      </Link>
    </div>
  );
}
