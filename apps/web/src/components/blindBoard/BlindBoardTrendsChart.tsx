import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BlindBoardTrendsResponse,
  StatsTrendsBucket,
} from '@kingside/shared';
import { api } from '../../api';

/**
 * KS-3511 (ADR-093 §4.2) — линейный тренд `bestStreak` по бакетам.
 * Default bucket — `week`. Inline-SVG (без recharts).
 */

const PADDING = { top: 16, right: 16, bottom: 28, left: 36 };
const WIDTH = 560;
const HEIGHT = 220;
const LINE_COLOR = '#10b981';
const DOT_COLOR = '#047857';
const GRID_COLOR = 'rgba(16, 185, 129, 0.18)';

export interface BlindBoardTrendsChartProps {
  fetcher?: (
    bucket: StatsTrendsBucket,
  ) => Promise<BlindBoardTrendsResponse>;
  initialBucket?: StatsTrendsBucket;
}

export function BlindBoardTrendsChart({
  fetcher,
  initialBucket = 'week',
}: BlindBoardTrendsChartProps = {}) {
  const { t } = useTranslation();
  const [bucket, setBucket] = useState<StatsTrendsBucket>(initialBucket);
  const [data, setData] = useState<BlindBoardTrendsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const doFetch = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const get =
        fetcher ??
        ((b: StatsTrendsBucket) =>
          api.get<BlindBoardTrendsResponse>(
            `/blind-board/trends/me?bucket=${b}`,
          ));
      setData(await get(bucket));
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

  const points = useMemo(() => {
    if (!data) return [] as Array<{ date: string; y: number; sessions: number }>;
    return data.points
      .filter((p) => p.sessions > 0)
      .map((p) => ({
        date: p.date,
        y: p.bestStreak,
        sessions: p.sessions,
      }));
  }, [data]);

  const { path, dots, xLabels, yMax } = useMemo(() => {
    if (points.length === 0)
      return { path: '', dots: [], xLabels: [] as string[], yMax: 1 };
    const innerW = WIDTH - PADDING.left - PADDING.right;
    const innerH = HEIGHT - PADDING.top - PADDING.bottom;
    const n = points.length;
    const stepX = n > 1 ? innerW / (n - 1) : 0;
    const maxY = Math.max(1, ...points.map((p) => p.y));
    const toY = (val: number): number =>
      PADDING.top + innerH * (1 - val / maxY);
    const coords = points.map((p, i) => ({
      x: PADDING.left + stepX * i,
      y: toY(p.y),
      val: p.y,
      sessions: p.sessions,
      date: p.date,
    }));
    const d = coords
      .map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
      .join(' ');
    const labels =
      n === 1
        ? [points[0].date]
        : [points[0].date, points[points.length - 1].date];
    return { path: d, dots: coords, xLabels: labels, yMax: maxY };
  }, [points]);

  return (
    <section
      className="blind-board-trends"
      data-testid="blind-board-trends"
      data-state={
        loading
          ? 'loading'
          : error
            ? 'error'
            : points.length === 0
              ? 'empty'
              : 'ready'
      }
      data-bucket={bucket}
      data-points={String(points.length)}
    >
      <header className="blind-board-trends__header">
        <h2 className="blind-board-trends__title">
          {t('blindBoard.trends.title', 'Best-streak trend')}
        </h2>
        <div
          className="blind-board-trends__controls"
          role="radiogroup"
          aria-label={t('blindBoard.trends.bucketAria', 'Trend bucket')}
        >
          {(['day', 'week', 'month'] as const).map((b) => (
            <label
              key={b}
              className={`blind-board-trends__bucket${
                bucket === b ? ' blind-board-trends__bucket--active' : ''
              }`}
              data-testid={`blind-board-trends-bucket-${b}`}
              data-active={bucket === b ? 'true' : 'false'}
            >
              <input
                type="radio"
                name="blind-board-trends-bucket"
                value={b}
                checked={bucket === b}
                onChange={() => setBucket(b)}
              />
              <span>{t(`blindBoard.trends.bucket.${b}`, b)}</span>
            </label>
          ))}
        </div>
      </header>

      {loading && (
        <div
          className="blind-board-trends__skeleton"
          data-testid="blind-board-trends-skeleton"
        />
      )}
      {!loading && error && (
        <div
          className="blind-board-trends__error"
          data-testid="blind-board-trends-error"
        >
          <span>{t('blindBoard.trends.error', 'Failed to load trend')}</span>
          <button type="button" onClick={() => void doFetch()}>
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}
      {!loading && !error && points.length === 0 && (
        <p
          className="blind-board-trends__placeholder"
          data-testid="blind-board-trends-placeholder"
        >
          {t('blindBoard.trends.empty', 'No data for this period yet')}
        </p>
      )}
      {!loading && !error && points.length > 0 && (
        <svg
          className="blind-board-trends__svg"
          data-testid="blind-board-trends-svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          width="100%"
          height={HEIGHT}
          role="img"
          aria-label={t('blindBoard.trends.title', 'Best-streak trend')}
        >
          {/* baseline 50% от макс. */}
          <line
            x1={PADDING.left}
            x2={WIDTH - PADDING.right}
            y1={
              PADDING.top + (HEIGHT - PADDING.top - PADDING.bottom) * 0.5
            }
            y2={
              PADDING.top + (HEIGHT - PADDING.top - PADDING.bottom) * 0.5
            }
            stroke={GRID_COLOR}
            strokeDasharray="4 4"
          />
          <path d={path} fill="none" stroke={LINE_COLOR} strokeWidth={2.5} />
          {dots.map((c, i) => (
            <g key={`${c.date}-${i}`}>
              <circle
                cx={c.x}
                cy={c.y}
                r={4}
                fill={DOT_COLOR}
                data-testid={`blind-board-trends-dot-${i}`}
              >
                <title>
                  {`${c.date} · streak ${c.val} · ${c.sessions} ${
                    c.sessions === 1
                      ? t('blindBoard.trends.session', 'session')
                      : t('blindBoard.trends.sessions', 'sessions')
                  }`}
                </title>
              </circle>
            </g>
          ))}
          {xLabels.map((lab, i) => (
            <text
              key={`${lab}-${i}`}
              x={i === 0 ? PADDING.left : WIDTH - PADDING.right}
              y={HEIGHT - 6}
              fontSize={11}
              fill="currentColor"
              textAnchor={i === 0 ? 'start' : 'end'}
              opacity={0.7}
            >
              {lab}
            </text>
          ))}
          {/* y-max label */}
          <text
            x={PADDING.left - 6}
            y={PADDING.top + 4}
            fontSize={11}
            fill="currentColor"
            textAnchor="end"
            opacity={0.7}
          >
            {yMax}
          </text>
        </svg>
      )}
    </section>
  );
}
