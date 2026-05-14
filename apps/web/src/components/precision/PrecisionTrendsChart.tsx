import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PrecisionTrendsResponse } from '@kingside/shared';
import { api } from '../../api';

/**
 * KS-2728 / ADR-056 §2.3 + §4 (Уровень В). График тренда точности —
 * `GET /precision/trends/me?bucket=week|month`. Отрисовка — inline SVG,
 * без recharts (не тащим лишнюю зависимость).
 *
 * # Layout
 * Линейный график:
 *   X = bucketStart (даты, шкала равномерная по индексу),
 *   Y = avgAccuracyPercent [0..100].
 * Tooltip на hover у точки — нативный <title>, без портала: дата,
 * attempts, preserved, accuracy, leak.
 * Переключатель week/month сверху.
 *
 * # Состояния
 *   loading: skeleton-плашка.
 *   error: «Не удалось загрузить тренд» + retry.
 *   empty (points.length === 0): «Сделай первые попытки чтобы увидеть тренд».
 *   ready: SVG.
 */

type Bucket = 'week' | 'month';

export interface PrecisionTrendsChartProps {
  /** DI для тестов. */
  fetcher?: (bucket: Bucket) => Promise<PrecisionTrendsResponse>;
}

// Размер viewBox — масштабируется по контейнеру через CSS.
const VB_W = 400;
const VB_H = 120;
const PAD_X = 24;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;

/**
 * KS-3024 / ADR-066 §7.3 (F1): дата миграции классификации
 * cp-loss → WDL-loss. Marker на trend-графике помечает «до/после»
 * момента, чтобы пользователь видел, что разрыв в accuracy в этой
 * точке — это смена методики, а не реальное падение/рост точности.
 *
 * Placeholder-значение. B3 (backend backfill) уточнит точную дату —
 * либо она прилетит в `PrecisionTrendsResponse` отдельным полем
 * `classifyMigrationAt`, либо в shared-константе. До тех пор хардкод
 * безопасен: пользователю эта дата НЕ выводится в виде даты (только
 * tooltip с пояснением), и сдвиг в пределах ±1 дня нагрузки UI не
 * меняет — marker всё равно попадёт в «недельный» бакет.
 */
export const CLASSIFY_WDL_MIGRATION_DATE = '2026-05-15';

export function PrecisionTrendsChart({ fetcher }: PrecisionTrendsChartProps = {}) {
  const { t } = useTranslation();
  const [bucket, setBucket] = useState<Bucket>('week');
  const [data, setData] = useState<PrecisionTrendsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<boolean>(false);

  const doFetch = useCallback(
    async (b: Bucket) => {
      const get =
        fetcher ??
        ((bb: Bucket) =>
          api.get<PrecisionTrendsResponse>(
            `/precision/trends/me?bucket=${bb}`,
          ));
      setLoading(true);
      setError(false);
      try {
        const res = await get(b);
        setData(res);
      } catch {
        setError(true);
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [fetcher],
  );

  useEffect(() => {
    void doFetch(bucket);
  }, [doFetch, bucket]);

  const points = useMemo(() => data?.points ?? [], [data]);

  /**
   * KS-3024 / ADR-066 §7.3 (F1): X-координата marker'а или `null`, если
   * дата миграции вне диапазона видимых точек. Считаем по timestamp'у,
   * а не по индексу бакета — иначе при пустых бакетах marker «прыгает».
   * Если до миграции точек нет (все после) или после — нет (все до),
   * marker не рисуется.
   */
  const migrationMarkerX = useMemo<number | null>(() => {
    if (points.length < 2) return null;
    const migrationTs = Date.parse(CLASSIFY_WDL_MIGRATION_DATE);
    if (Number.isNaN(migrationTs)) return null;
    const firstTs = Date.parse(points[0].bucketStart);
    const lastTs = Date.parse(points[points.length - 1].bucketStart);
    if (
      Number.isNaN(firstTs) ||
      Number.isNaN(lastTs) ||
      migrationTs < firstTs ||
      migrationTs > lastTs
    ) {
      return null;
    }
    const span = Math.max(1, lastTs - firstTs);
    const frac = (migrationTs - firstTs) / span;
    const innerW = VB_W - PAD_X * 2;
    return PAD_X + frac * innerW;
  }, [points]);

  const path = useMemo(() => {
    if (points.length === 0) return '';
    const innerW = VB_W - PAD_X * 2;
    const innerH = VB_H - PAD_TOP - PAD_BOTTOM;
    const denom = Math.max(1, points.length - 1);
    return points
      .map((p, i) => {
        const x = PAD_X + (i / denom) * innerW;
        // accuracyPercent 0..100 → y отображаем сверху=100%, снизу=0%.
        const yNorm = Math.max(0, Math.min(100, p.avgAccuracyPercent)) / 100;
        const y = PAD_TOP + (1 - yNorm) * innerH;
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(' ');
  }, [points]);

  const renderToggle = () => (
    <div
      className="precision-trends__toggle"
      role="tablist"
      aria-label={t('precisionTrends.toggleLabel', 'Bucket size')}
    >
      {(['week', 'month'] as const).map((b) => (
        <button
          key={b}
          type="button"
          role="tab"
          aria-selected={bucket === b}
          className={`precision-trends__toggle-btn${bucket === b ? ' precision-trends__toggle-btn--active' : ''}`}
          onClick={() => setBucket(b)}
          data-testid={`precision-trends-bucket-${b}`}
        >
          {b === 'week'
            ? t('precisionTrends.week', 'Week')
            : t('precisionTrends.month', 'Month')}
        </button>
      ))}
    </div>
  );

  if (loading) {
    return (
      <section
        className="precision-trends"
        data-testid="precision-trends"
        data-state="loading"
      >
        <header className="precision-trends__header">
          <h2 className="precision-trends__title">
            {t('precisionTrends.title', 'Accuracy trend')}
          </h2>
          {renderToggle()}
        </header>
        <div
          className="precision-trends__skeleton"
          data-testid="precision-trends-skeleton"
        />
      </section>
    );
  }

  if (error) {
    return (
      <section
        className="precision-trends"
        data-testid="precision-trends"
        data-state="error"
      >
        <header className="precision-trends__header">
          <h2 className="precision-trends__title">
            {t('precisionTrends.title', 'Accuracy trend')}
          </h2>
          {renderToggle()}
        </header>
        <p className="precision-trends__msg">
          {t('precisionTrends.loadError', 'Could not load trend.')}
        </p>
        <button
          type="button"
          className="precision-trends__retry"
          onClick={() => void doFetch(bucket)}
          data-testid="precision-trends-retry"
        >
          {t('common.retry', 'Retry')}
        </button>
      </section>
    );
  }

  if (points.length === 0) {
    return (
      <section
        className="precision-trends"
        data-testid="precision-trends"
        data-state="empty"
      >
        <header className="precision-trends__header">
          <h2 className="precision-trends__title">
            {t('precisionTrends.title', 'Accuracy trend')}
          </h2>
          {renderToggle()}
        </header>
        <p
          className="precision-trends__msg"
          data-testid="precision-trends-empty"
        >
          {t(
            'precisionTrends.empty',
            'Play your first attempts to see the trend.',
          )}
        </p>
      </section>
    );
  }

  return (
    <section
      className="precision-trends"
      data-testid="precision-trends"
      data-state="ready"
      data-bucket={bucket}
      data-points={String(points.length)}
    >
      <header className="precision-trends__header">
        <h2 className="precision-trends__title">
          {t('precisionTrends.title', 'Accuracy trend')}
        </h2>
        {renderToggle()}
      </header>
      <svg
        className="precision-trends__svg"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t(
          'precisionTrends.aria',
          'Accuracy across time buckets',
        )}
      >
        {/* baseline 50% */}
        <line
          x1={PAD_X}
          y1={PAD_TOP + (VB_H - PAD_TOP - PAD_BOTTOM) / 2}
          x2={VB_W - PAD_X}
          y2={PAD_TOP + (VB_H - PAD_TOP - PAD_BOTTOM) / 2}
          stroke="rgba(255,255,255,0.15)"
          strokeWidth={0.5}
        />
        {/* KS-3024 / ADR-066 §7.3 (F1): vertical marker даты миграции
            cp-loss → WDL-loss. Тонкая пунктирная линия + подпись
            «Methodology updated» сверху + <title>-tooltip с полным
            пояснением. Рисуется только если дата попадает в видимый
            диапазон бакетов. */}
        {migrationMarkerX !== null && (
          <g
            className="precision-trends__migration-marker"
            data-testid="precision-trends-migration-marker"
            data-migration-date={CLASSIFY_WDL_MIGRATION_DATE}
          >
            <line
              x1={migrationMarkerX}
              y1={PAD_TOP}
              x2={migrationMarkerX}
              y2={VB_H - PAD_BOTTOM}
              stroke="#facc15"
              strokeWidth={0.8}
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            >
              <title>
                {t(
                  'precisionTrends.migrationTooltip',
                  'Move classification method updated (ADR-066). Before this date moves were classified by cp-loss; now by WDL-loss. Accuracy went up on theoretically winning positions — keeping the advantage is no longer counted as a mistake.',
                )}
              </title>
            </line>
            <text
              x={migrationMarkerX + 2}
              y={PAD_TOP + 7}
              fontSize={7}
              fill="#facc15"
              data-testid="precision-trends-migration-marker-label"
            >
              {t('precisionTrends.migrationMarker', 'Method update')}
            </text>
          </g>
        )}
        {/* линия тренда */}
        <path
          d={path}
          fill="none"
          stroke="#4ea1f7"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
        {/* точки + tooltip через title */}
        {points.map((p, i) => {
          const innerW = VB_W - PAD_X * 2;
          const innerH = VB_H - PAD_TOP - PAD_BOTTOM;
          const denom = Math.max(1, points.length - 1);
          const x = PAD_X + (i / denom) * innerW;
          const yNorm =
            Math.max(0, Math.min(100, p.avgAccuracyPercent)) / 100;
          const y = PAD_TOP + (1 - yNorm) * innerH;
          const tooltipText = t('precisionTrends.tooltip', {
            defaultValue:
              '{{date}} · {{attempts}} attempts · {{preserved}} preserved · acc {{acc}}% · leak {{leak}}',
            date: new Date(p.bucketStart).toLocaleDateString(),
            attempts: p.attempts,
            preserved: p.preserved,
            acc: Math.round(p.avgAccuracyPercent),
            leak: (p.avgWdlLeakPerMove * 100).toFixed(1) + '%',
          });
          return (
            <g key={i} data-testid={`precision-trends-point-${i}`}>
              <circle
                cx={x}
                cy={y}
                r={2.5}
                fill="#4ea1f7"
                stroke="#0b1220"
                strokeWidth={0.5}
              >
                <title>{tooltipText}</title>
              </circle>
            </g>
          );
        })}
        {/* X-подписи: первая и последняя дата */}
        {points.length > 0 && (
          <>
            <text
              x={PAD_X}
              y={VB_H - 4}
              fontSize={8}
              fill="rgba(255,255,255,0.5)"
            >
              {new Date(points[0].bucketStart).toLocaleDateString()}
            </text>
            <text
              x={VB_W - PAD_X}
              y={VB_H - 4}
              fontSize={8}
              textAnchor="end"
              fill="rgba(255,255,255,0.5)"
            >
              {new Date(
                points[points.length - 1].bucketStart,
              ).toLocaleDateString()}
            </text>
          </>
        )}
      </svg>
    </section>
  );
}
