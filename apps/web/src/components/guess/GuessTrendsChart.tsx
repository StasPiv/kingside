import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  GuessTrendsResponse,
  StatsTrendsBucket,
} from '@kingside/shared';
import { api } from '../../api';

/**
 * KS-3510 (ADR-093 §3.2) — Линейный тренд `avgUserAccuracy` по неделям
 * (default `bucket=week`). Простой inline-SVG без recharts (тот же
 * подход что в `PrecisionTrendsChart`, но без расширенных контролов —
 * это первая итерация, расширим если потребуется).
 *
 * Источник — `GET /guess/trends/me?bucket=week` (B-guess, KS-3508).
 *
 * Состояния:
 *   loading: skeleton.
 *   error:   placeholder + retry.
 *   empty:   placeholder «нет данных».
 *   ready:   SVG-линия.
 */

const PADDING = { top: 16, right: 16, bottom: 28, left: 36 };
const WIDTH = 560;
const HEIGHT = 220;
const LINE_COLOR = '#7c83ff';
const DOT_COLOR = '#5b63d3';
const GRID_COLOR = 'rgba(124, 131, 255, 0.18)';

export interface GuessTrendsChartProps {
  fetcher?: (bucket: StatsTrendsBucket) => Promise<GuessTrendsResponse>;
  /** Дефолтный bucket — week по ADR-093. */
  initialBucket?: StatsTrendsBucket;
}

export function GuessTrendsChart({
  fetcher,
  initialBucket = 'week',
}: GuessTrendsChartProps = {}) {
  const { t } = useTranslation();
  const [bucket, setBucket] = useState<StatsTrendsBucket>(initialBucket);
  const [data, setData] = useState<GuessTrendsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const doFetch = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const get =
        fetcher ??
        ((b: StatsTrendsBucket) =>
          api.get<GuessTrendsResponse>(`/guess/trends/me?bucket=${b}`));
      const res = await get(bucket);
      setData(res);
    } catch {
      setError(true);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [fetcher, bucket]);

  useEffect(() => {
    void doFetch();
  }, [doFetch]);

  // Берём только точки с непустой accuracy для линии — пустые бакеты
  // создают gap'ы (sessions=0).
  const points = useMemo(() => {
    if (!data) return [] as Array<{ date: string; y: number; sessions: number }>;
    return data.points
      .filter((p) => p.avgUserAccuracy != null)
      .map((p) => ({
        date: p.date,
        y: p.avgUserAccuracy as number,
        sessions: p.sessions,
      }));
  }, [data]);

  const { path, dots, xLabels } = useMemo(() => {
    if (points.length === 0) {
      return { path: '', dots: [], xLabels: [] as string[] };
    }
    const innerW = WIDTH - PADDING.left - PADDING.right;
    const innerH = HEIGHT - PADDING.top - PADDING.bottom;
    const n = points.length;
    const stepX = n > 1 ? innerW / (n - 1) : 0;
    const toY = (val: number): number =>
      PADDING.top + innerH * (1 - val / 100);
    const coords = points.map((p, i) => ({
      x: PADDING.left + stepX * i,
      y: toY(p.y),
      sessions: p.sessions,
      val: p.y,
      date: p.date,
    }));
    const d = coords
      .map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
      .join(' ');
    const labels =
      n === 1
        ? [points[0].date]
        : [points[0].date, points[points.length - 1].date];
    return { path: d, dots: coords, xLabels: labels };
  }, [points]);

  return (
    <section
      className="guess-trends"
      data-testid="guess-trends"
      data-state={
        loading ? 'loading' : error ? 'error' : points.length === 0 ? 'empty' : 'ready'
      }
      data-bucket={bucket}
      data-points={String(points.length)}
    >
      <header className="guess-trends__header">
        <h2 className="guess-trends__title">
          {t('guess.trends.title', 'Accuracy trend')}
        </h2>
        <div
          className="guess-trends__controls"
          role="radiogroup"
          aria-label={t('guess.trends.bucketAria', 'Trend bucket')}
        >
          {(['day', 'week', 'month'] as const).map((b) => (
            <label
              key={b}
              className={`guess-trends__bucket${
                bucket === b ? ' guess-trends__bucket--active' : ''
              }`}
              data-testid={`guess-trends-bucket-${b}`}
              data-active={bucket === b ? 'true' : 'false'}
            >
              <input
                type="radio"
                name="guess-trends-bucket"
                value={b}
                checked={bucket === b}
                onChange={() => setBucket(b)}
              />
              <span>{t(`guess.trends.bucket.${b}`, b)}</span>
            </label>
          ))}
        </div>
      </header>

      {loading && (
        <div
          className="guess-trends__skeleton"
          data-testid="guess-trends-skeleton"
        />
      )}
      {!loading && error && (
        <div
          className="guess-trends__error"
          data-testid="guess-trends-error"
        >
          <span>{t('guess.trends.error', 'Failed to load trend')}</span>
          <button type="button" onClick={() => void doFetch()}>
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}
      {!loading && !error && points.length === 0 && (
        <p
          className="guess-trends__placeholder"
          data-testid="guess-trends-placeholder"
        >
          {t('guess.trends.empty', 'No data for this period yet')}
        </p>
      )}
      {!loading && !error && points.length > 0 && (
        <svg
          className="guess-trends__svg"
          data-testid="guess-trends-svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          width="100%"
          height={HEIGHT}
          role="img"
          aria-label={t('guess.trends.title', 'Accuracy trend')}
        >
          {/* baseline 50% */}
          <line
            x1={PADDING.left}
            x2={WIDTH - PADDING.right}
            y1={PADDING.top + (HEIGHT - PADDING.top - PADDING.bottom) * 0.5}
            y2={PADDING.top + (HEIGHT - PADDING.top - PADDING.bottom) * 0.5}
            stroke={GRID_COLOR}
            strokeDasharray="4 4"
          />
          {/* line */}
          <path
            d={path}
            fill="none"
            stroke={LINE_COLOR}
            strokeWidth={2.5}
          />
          {/* dots с native title */}
          {dots.map((c, i) => (
            <g key={`${c.date}-${i}`}>
              <circle
                cx={c.x}
                cy={c.y}
                r={4}
                fill={DOT_COLOR}
                data-testid={`guess-trends-dot-${i}`}
              >
                <title>
                  {`${c.date} · ${Math.round(c.val)}% · ${c.sessions} ${
                    c.sessions === 1
                      ? t('guess.trends.session', 'session')
                      : t('guess.trends.sessions', 'sessions')
                  }`}
                </title>
              </circle>
            </g>
          ))}
          {/* x-labels */}
          {xLabels.map((lab, i) => (
            <text
              key={`${lab}-${i}`}
              x={
                i === 0
                  ? PADDING.left
                  : WIDTH - PADDING.right
              }
              y={HEIGHT - 6}
              fontSize={11}
              fill="currentColor"
              textAnchor={i === 0 ? 'start' : 'end'}
              opacity={0.7}
            >
              {lab}
            </text>
          ))}
        </svg>
      )}
    </section>
  );
}
