/**
 * KS-4360 / ADR-136 T8. Страница `/critical-moment/stats` — личная
 * статистика по разделу «Точность».
 *
 * Источники данных:
 *   - `GET /critical-moment/stats/me` → `TacticUserStats` (рейтинг + Glicko,
 *     тоталы, серия, разрезы по stopReason/difficulty);
 *   - `GET /critical-moment/stats/rating-history` → `TacticRatingPoint[]`
 *     (точки графика рейтинга по дням, фильтр `from`/`to`).
 *
 * Блоки:
 *   1. Подвигация раздела (`TacticPuzzlesSubNav`).
 *   2. Рейтинг + Glicko deviation, серия (current/best).
 *   3. Тоталы (попытки, % решённых, среднее время / длина линии / оценка).
 *   4. Линейный график рейтинга (inline SVG) с переключателем периода
 *      «Неделя / Месяц / Всё время».
 *   5. Разрез по причинам остановки (горизонтальные полосы).
 *   6. Гистограмма по бакетам сложности.
 *
 * Гостям эндпоинты вернут 401 — рендерим приглашение войти.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  TacticRatingPoint,
  TacticStopReason,
  TacticUserStats,
} from '@kingside/shared';
import { useAuth } from '../context/AuthContext';
import { PageSeo } from '../components/seo/PageSeo';
import { TacticPuzzlesSubNav } from '../components/tactic-puzzles/TacticPuzzlesSubNav';
import { tacticPuzzleApi } from '../api/api-tactic-puzzle';

const STOP_REASONS: readonly TacticStopReason[] = [
  'easy',
  'mate',
  'mistake',
  'timeout',
  'aborted',
];

type RatingRange = 'week' | 'month' | 'all';

function rangeFromIso(range: RatingRange): string | undefined {
  if (range === 'all') return undefined;
  const now = new Date();
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  if (range === 'week') {
    const d = new Date(day);
    d.setUTCDate(d.getUTCDate() - 6);
    return d.toISOString();
  }
  const d = new Date(day);
  d.setUTCDate(d.getUTCDate() - 29);
  return d.toISOString();
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

/**
 * Простой inline-SVG линейный график рейтинга. Без сторонних библиотек —
 * образец `PrecisionTrendsChart` тоже на SVG. Поддерживает пропуски дней
 * (точки соединяются прямой линией, разрывы не вводим — ADR-136 §3.6
 * допускает оба варианта, выбран более читаемый для редких попыток).
 */
function RatingChart({ points }: { points: TacticRatingPoint[] }) {
  const { t } = useTranslation();
  const width = 600;
  const height = 220;
  const padX = 36;
  const padY = 18;

  if (points.length === 0) {
    return (
      <p
        className="tactic-stats__chart-empty"
        data-testid="tactic-stats-chart-empty"
      >
        {t('tacticPuzzle.stats.ratingHistory.noPoints', 'No data points.')}
      </p>
    );
  }

  const ratings = points.map((p) => p.rating);
  const minR = Math.min(...ratings);
  const maxR = Math.max(...ratings);
  const range = Math.max(1, maxR - minR);
  const xStep =
    points.length > 1
      ? (width - 2 * padX) / (points.length - 1)
      : 0;

  const path = points
    .map((p, i) => {
      const x = padX + i * xStep;
      const y =
        height - padY - ((p.rating - minR) / range) * (height - 2 * padY);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      className="tactic-stats__chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={t(
        'tacticPuzzle.stats.ratingHistory.title',
        'Rating dynamics',
      )}
      data-testid="tactic-stats-chart"
    >
      <text x={4} y={padY + 4} className="tactic-stats__chart-label">
        {maxR}
      </text>
      <text x={4} y={height - padY + 4} className="tactic-stats__chart-label">
        {minR}
      </text>
      <line
        x1={padX}
        y1={height - padY}
        x2={width - padX}
        y2={height - padY}
        className="tactic-stats__chart-axis"
      />
      <path d={path} className="tactic-stats__chart-line" />
      {points.map((p, i) => {
        const x = padX + i * xStep;
        const y =
          height - padY - ((p.rating - minR) / range) * (height - 2 * padY);
        return (
          <circle
            key={`${p.date}-${i}`}
            cx={x}
            cy={y}
            r={3}
            className="tactic-stats__chart-dot"
          >
            <title>
              {p.date}: {p.rating} (attempts {p.attempts}, solved {p.solved})
            </title>
          </circle>
        );
      })}
    </svg>
  );
}

interface BarRow {
  label: string;
  value: number;
}

function HorizontalBars({
  rows,
  testIdPrefix,
}: {
  rows: BarRow[];
  testIdPrefix: string;
}) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <ul
      className="tactic-stats__bars"
      data-testid={`${testIdPrefix}-bars`}
    >
      {rows.map((row) => {
        const pct = total > 0 ? (row.value / total) * 100 : 0;
        return (
          <li
            key={row.label}
            className="tactic-stats__bar-row"
            data-testid={`${testIdPrefix}-${row.label}`}
          >
            <span className="tactic-stats__bar-label">{row.label}</span>
            <span className="tactic-stats__bar-track">
              <span
                className="tactic-stats__bar-fill"
                style={{ width: `${pct.toFixed(1)}%` }}
              />
            </span>
            <span className="tactic-stats__bar-value">
              {row.value}
              {total > 0 ? ` · ${pct.toFixed(0)}%` : ''}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function TacticPuzzlesStatsPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const isGuest = !user;

  const [stats, setStats] = useState<TacticUserStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [points, setPoints] = useState<TacticRatingPoint[] | null>(null);
  const [range, setRange] = useState<RatingRange>('month');
  const [loadingHistory, setLoadingHistory] = useState(true);

  // ── Загрузка stats/me ───────────────────────────────────────────
  useEffect(() => {
    if (isGuest) {
      setLoadingStats(false);
      return;
    }
    let cancelled = false;
    setLoadingStats(true);
    setStatsError(null);
    tacticPuzzleApi
      .getMyStats()
      .then((data) => {
        if (cancelled) return;
        setStats(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatsError(e instanceof Error ? e.message : 'Failed to load stats');
      })
      .finally(() => {
        if (!cancelled) setLoadingStats(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isGuest]);

  // ── Загрузка rating-history ─────────────────────────────────────
  useEffect(() => {
    if (isGuest) {
      setLoadingHistory(false);
      return;
    }
    let cancelled = false;
    setLoadingHistory(true);
    tacticPuzzleApi
      .getRatingHistory({ from: rangeFromIso(range), granularity: 'day' })
      .then((data) => {
        if (cancelled) return;
        setPoints(data ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setPoints([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isGuest, range]);

  // ── Подготовка данных для блоков ────────────────────────────────
  const stopReasonRows: BarRow[] = useMemo(() => {
    if (!stats) return [];
    return STOP_REASONS.map((r) => ({
      label: t(`tacticPuzzle.history.stopReason.${r}`, r),
      value: stats.stopReasonBreakdown[r] ?? 0,
    }));
  }, [stats, t]);

  const difficultyRows: BarRow[] = useMemo(() => {
    if (!stats) return [];
    return Object.entries(stats.difficultyBuckets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, value]) => ({ label, value }));
  }, [stats]);

  const handleRangeChange = useCallback(
    (next: RatingRange) => setRange(next),
    [],
  );

  const pageState: 'guest' | 'loading' | 'error' | 'empty' | 'ready' = isGuest
    ? 'guest'
    : loadingStats
      ? 'loading'
      : statsError
        ? 'error'
        : !stats || stats.totals.attempts === 0
          ? 'empty'
          : 'ready';

  return (
    <div
      className="tactic-puzzles-stats"
      data-testid="tactic-puzzles-stats"
      data-auth={isGuest ? 'guest' : 'user'}
      data-state={pageState}
    >
      <PageSeo
        ns="tacticPuzzles.stats"
        path="/critical-moment/stats"
        noindex
      />
      <TacticPuzzlesSubNav />

      <header className="tactic-puzzles-stats__header">
        <h1>{t('tacticPuzzle.stats.title', 'Stats — tactics training')}</h1>
        <p className="tactic-puzzles-stats__intro">
          {t(
            'tacticPuzzle.stats.intro',
            'Summary of your Tactics section: current rating, totals and breakdowns by stop reason and difficulty.',
          )}
        </p>
      </header>

      {pageState === 'guest' && (
        <section
          className="tactic-puzzles-stats__guest"
          data-testid="tactic-puzzles-stats-guest"
        >
          <h2>
            {t('tacticPuzzle.stats.guestTitle', 'Sign in to see stats')}
          </h2>
          <p>
            {t(
              'tacticPuzzle.stats.guestMessage',
              'Stats are available to signed-in players only.',
            )}
          </p>
          <Link to="/login" className="tactic-puzzles-stats__guest-cta">
            {t('precision.history.guest.cta', 'Sign in')}
          </Link>
        </section>
      )}

      {pageState === 'loading' && (
        <p
          className="tactic-puzzles-stats__status"
          data-testid="tactic-puzzles-stats-loading"
        >
          {t('common.loading', 'Loading…')}
        </p>
      )}

      {pageState === 'error' && (
        <div
          className="tactic-puzzles-stats__status tactic-puzzles-stats__status--error"
          data-testid="tactic-puzzles-stats-error"
        >
          <p>
            {t(
              'tacticPuzzle.stats.loadError',
              'Could not load stats.',
            )}
          </p>
          <button type="button" onClick={() => window.location.reload()}>
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}

      {pageState === 'empty' && (
        <p
          className="tactic-puzzles-stats__status tactic-puzzles-stats__status--empty"
          data-testid="tactic-puzzles-stats-empty"
        >
          {t(
            'tacticPuzzle.stats.empty',
            'Solve your first puzzle — stats will show up here.',
          )}
        </p>
      )}

      {pageState === 'ready' && stats && (
        <div
          className="tactic-puzzles-stats__grid"
          data-testid="tactic-puzzles-stats-grid"
        >
          <section
            className="tactic-stats__card tactic-stats__card--rating"
            data-testid="tactic-stats-rating"
          >
            <h2>{t('tacticPuzzle.stats.rating.title', 'Rating')}</h2>
            <div className="tactic-stats__rating-value">
              {stats.rating.value}
            </div>
            <div className="tactic-stats__rating-meta">
              <span>
                ±{stats.rating.deviation}{' '}
                {t(
                  'tacticPuzzle.stats.rating.deviation',
                  'Glicko deviation',
                )}
              </span>
              <span>
                {stats.rating.attempts}{' '}
                {t('tacticPuzzle.stats.rating.attempts', 'attempts')}
              </span>
              <span>
                {t('tacticPuzzle.stats.rating.lastAttempt', 'Last attempt')}
                :{' '}
                {stats.rating.lastAttemptAt
                  ? formatDate(stats.rating.lastAttemptAt, i18n.language)
                  : t('tacticPuzzle.stats.rating.noLast', 'not played yet')}
              </span>
            </div>
          </section>

          <section
            className="tactic-stats__card tactic-stats__card--streak"
            data-testid="tactic-stats-streak"
          >
            <h2>{t('tacticPuzzle.stats.streak.title', 'Streak')}</h2>
            <div className="tactic-stats__streak-row">
              <div>
                <span className="tactic-stats__streak-value">
                  {stats.streak.current}
                </span>
                <span className="tactic-stats__streak-label">
                  {t('tacticPuzzle.stats.streak.current', 'Current')}
                </span>
              </div>
              <div>
                <span className="tactic-stats__streak-value">
                  {stats.streak.best}
                </span>
                <span className="tactic-stats__streak-label">
                  {t('tacticPuzzle.stats.streak.best', 'Best')}
                </span>
              </div>
            </div>
          </section>

          <section
            className="tactic-stats__card tactic-stats__card--totals"
            data-testid="tactic-stats-totals"
          >
            <h2>{t('tacticPuzzle.stats.totals.title', 'Totals')}</h2>
            <dl className="tactic-stats__totals">
              <div>
                <dt>{t('tacticPuzzle.stats.totals.attempts', 'Attempts')}</dt>
                <dd>{stats.totals.attempts}</dd>
              </div>
              <div>
                <dt>{t('tacticPuzzle.stats.totals.solved', 'Solved')}</dt>
                <dd>{stats.totals.solved}</dd>
              </div>
              <div>
                <dt>
                  {t('tacticPuzzle.stats.totals.solvedPercent', '% solved')}
                </dt>
                <dd>{stats.totals.solvedPercent}%</dd>
              </div>
              <div>
                <dt>{t('tacticPuzzle.stats.totals.avgTime', 'Avg time')}</dt>
                <dd>{formatDurationMs(stats.totals.avgTimeMs)}</dd>
              </div>
              <div>
                <dt>
                  {t('tacticPuzzle.stats.totals.avgLine', 'Avg line length')}
                </dt>
                <dd>
                  {stats.totals.avgLineHalfMoves.toFixed(1)}
                </dd>
              </div>
              <div>
                <dt>{t('tacticPuzzle.stats.totals.avgGrade', 'Avg grade')}</dt>
                <dd>
                  {stats.totals.avgPrecisionGrade != null
                    ? stats.totals.avgPrecisionGrade.toFixed(2)
                    : '—'}
                </dd>
              </div>
            </dl>
          </section>

          <section
            className="tactic-stats__card tactic-stats__card--chart"
            data-testid="tactic-stats-chart-card"
          >
            <header className="tactic-stats__chart-header">
              <h2>
                {t(
                  'tacticPuzzle.stats.ratingHistory.title',
                  'Rating dynamics',
                )}
              </h2>
              <div
                className="tactic-stats__chart-ranges"
                role="tablist"
                aria-label={t(
                  'tacticPuzzle.stats.ratingHistory.title',
                  'Rating dynamics',
                )}
              >
                {(['week', 'month', 'all'] as const).map((r) => {
                  const active = range === r;
                  return (
                    <button
                      key={r}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      data-testid={`tactic-stats-range-${r}`}
                      className={`tactic-stats__range${
                        active ? ' tactic-stats__range--active' : ''
                      }`}
                      onClick={() => handleRangeChange(r)}
                    >
                      {t(
                        `tacticPuzzle.stats.ratingHistory.range${
                          r.charAt(0).toUpperCase() + r.slice(1)
                        }`,
                        r,
                      )}
                    </button>
                  );
                })}
              </div>
            </header>
            {loadingHistory ? (
              <p data-testid="tactic-stats-chart-loading">
                {t('common.loading', 'Loading…')}
              </p>
            ) : (
              <RatingChart points={points ?? []} />
            )}
          </section>

          <section
            className="tactic-stats__card"
            data-testid="tactic-stats-stop-reason"
          >
            <h2>
              {t('tacticPuzzle.stats.stopReason.title', 'Stop reasons')}
            </h2>
            <HorizontalBars
              rows={stopReasonRows}
              testIdPrefix="tactic-stats-stop"
            />
          </section>

          <section
            className="tactic-stats__card"
            data-testid="tactic-stats-difficulty"
          >
            <h2>
              {t(
                'tacticPuzzle.stats.difficulty.title',
                'Difficulty distribution',
              )}
            </h2>
            <HorizontalBars
              rows={difficultyRows}
              testIdPrefix="tactic-stats-diff"
            />
          </section>
        </div>
      )}
    </div>
  );
}
