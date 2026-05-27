import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import type { PrecisionTrendsResponse } from '@kingside/shared';
import { api } from '../../api';

/**
 * KS-2728 / ADR-056 §2.3 + §4 (Уровень В). График тренда точности —
 * `GET /precision/trends/me?bucket=day&since=<from>&until=<to>`.
 * Отрисовка — inline SVG, без recharts.
 *
 * # KS-3040: окно «Неделя/Месяц» вместо weekly/monthly бакетов
 * Раньше переключатель отправлял `bucket=week|month` и backend
 * возвращал недельные/месячные агрегаты. Если у пользователя был
 * только один такой бакет (1 неделя данных), на оси X получалось
 * «11.05.2026 — 11.05.2026», одна точка по центру, без понимания,
 * за какой период график.
 *
 * Теперь переключатель — это длина видимого окна:
 *   - Неделя = последние 7 дней (today-6 ... today),
 *   - Месяц  = последние 30 дней (today-29 ... today).
 * Backend всегда зовём с `bucket=day` + `since`/`until`, и точки
 * расставляем по реальной дате внутри окна. X-подписи — границы окна
 * (константа для выбранного режима), независимо от количества данных.
 *
 * # Layout
 * Линейный график:
 *   X = реальная дата bucketStart внутри окна,
 *   Y = avgAccuracyPercent [0..100].
 * Tooltip на hover у точки — нативный <title>: дата, attempts,
 * preserved, accuracy, leak.
 *
 * # Состояния
 *   loading: skeleton-плашка.
 *   error: «Не удалось загрузить тренд» + retry.
 *   empty (points.length === 0): «Сделай первые попытки чтобы увидеть тренд».
 *   ready: SVG.
 */

type WindowMode = 'week' | 'month';

/**
 * KS-3377 (ADR-082 §3 / §7 F2). Метрика тренда: точность ходов (KS-2728
 * legacy) либо precision-рейтинг (KS-3375 ratingEnd / ratingDelta).
 *  - `'accuracy'`: Y = avgAccuracyPercent [0..100], baseline 50%.
 *  - `'rating'`: Y = ratingEnd, диапазон от min..max в видимых
 *    бакетах (gap-skip null). Tooltip — сумма delta за бакет.
 *
 * URL state `?metric=accuracy|rating`. Default `'accuracy'` для
 * backward-compat (старые сохранённые ссылки).
 */
type Metric = 'accuracy' | 'rating';

const WINDOW_DAYS_BY_MODE: Record<WindowMode, number> = {
  week: 7,
  month: 30,
};

function readMetricFromUrl(searchParams: URLSearchParams): Metric {
  const raw = searchParams.get('metric');
  return raw === 'rating' ? 'rating' : 'accuracy';
}

/**
 * Окно «последние N дней» с шагом 1 день. `since` — полночь дня
 * (today - (N-1)), `until` — полночь следующего за today дня (чтобы
 * текущие сутки попадали в выборку backend'а: трактовка `until`
 * по конвенции — exclusive).
 */
function computeWindow(
  mode: WindowMode,
  now: Date = new Date(),
): { since: Date; until: Date } {
  const days = WINDOW_DAYS_BY_MODE[mode];
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const since = new Date(todayStart);
  since.setDate(todayStart.getDate() - (days - 1));
  const until = new Date(todayStart);
  until.setDate(todayStart.getDate() + 1);
  return { since, until };
}

export interface PrecisionTrendsChartProps {
  /**
   * DI для тестов. Параметры — режим окна (`week` / `month`) и
   * рассчитанные границы окна. Реализация по умолчанию зовёт
   * `/precision/trends/me?bucket=day&since=&until=`.
   */
  fetcher?: (
    mode: WindowMode,
    range: { since: Date; until: Date },
  ) => Promise<PrecisionTrendsResponse>;
  /**
   * Тест-инъекция «сегодня». Production — `new Date()`. Нужно
   * детерминированно тестировать окно (today-6 … today).
   */
  now?: Date;
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

export function PrecisionTrendsChart({
  fetcher,
  now,
}: PrecisionTrendsChartProps = {}) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [mode, setMode] = useState<WindowMode>('week');
  const [data, setData] = useState<PrecisionTrendsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<boolean>(false);

  // KS-3377: метрика читается из URL. setMetric пишет обратно в URL.
  // Default 'accuracy' — backward-compat для уже сохранённых ссылок.
  const metric: Metric = readMetricFromUrl(searchParams);
  const setMetric = useCallback(
    (next: Metric) => {
      const sp = new URLSearchParams(searchParams);
      if (next === 'accuracy') sp.delete('metric');
      else sp.set('metric', next);
      setSearchParams(sp, { replace: false });
    },
    [searchParams, setSearchParams],
  );

  // Окно — мемо по mode/now. При смене mode useEffect ниже триггерит
  // fetch с новым окном.
  const range = useMemo(() => computeWindow(mode, now), [mode, now]);

  const doFetch = useCallback(
    async (m: WindowMode, r: { since: Date; until: Date }) => {
      const get =
        fetcher ??
        ((_mm: WindowMode, rr: { since: Date; until: Date }) =>
          api.get<PrecisionTrendsResponse>(
            // KS-3040: всегда bucket=day; ширина «окна» задаётся
            // since/until. UI-toggle переключает окно, а не bucket
            // backend'а — это и даёт стабильную ось X.
            `/precision/trends/me?bucket=day&since=${encodeURIComponent(
              rr.since.toISOString(),
            )}&until=${encodeURIComponent(rr.until.toISOString())}`,
          ));
      setLoading(true);
      setError(false);
      try {
        const res = await get(m, r);
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
    void doFetch(mode, range);
  }, [doFetch, mode, range]);

  const points = useMemo(() => data?.points ?? [], [data]);

  /**
   * KS-3040: позиция точки по X = доля даты bucketStart в окне
   * [since..until). При 1 точке она встанет в свою реальную дату,
   * а ось X сохранит границы окна как фиксированные подписи.
   */
  const xForDate = useCallback(
    (iso: string): number => {
      const ts = Date.parse(iso);
      const fromTs = range.since.getTime();
      const toTs = range.until.getTime();
      const span = Math.max(1, toTs - fromTs);
      const clamped = Math.max(fromTs, Math.min(toTs, Number.isNaN(ts) ? fromTs : ts));
      const frac = (clamped - fromTs) / span;
      const innerW = VB_W - PAD_X * 2;
      return PAD_X + frac * innerW;
    },
    [range],
  );

  /**
   * KS-3024 / ADR-066 §7.3 (F1): X-координата marker'а или `null`, если
   * дата миграции вне диапазона видимых точек. Marker рисуется только
   * когда у пользователя ЕСТЬ данные с обеих сторон миграции (≥2 точки,
   * первая ДО, последняя ПОСЛЕ) — иначе линия методики не визуализирует
   * ничего полезного. KS-3040 follow-up: позиция считается через
   * общий `xForDate` (окно since..until), что даёт корректный X
   * независимо от bucket-плотности.
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
    return xForDate(CLASSIFY_WDL_MIGRATION_DATE);
  }, [points, xForDate]);

  // KS-3377: rating-режим использует динамический Y-диапазон по
  // видимым `ratingEnd` (null-бакеты исключены). Расширяем ±10 пунктов
  // — даёт «воздух» сверху/снизу и устойчиво для одной-двух точек.
  const ratingRange = useMemo<{ min: number; max: number } | null>(() => {
    const ratings: number[] = [];
    for (const p of points) {
      if (p.ratingEnd != null) ratings.push(p.ratingEnd);
    }
    if (ratings.length === 0) return null;
    let min = Math.min(...ratings);
    let max = Math.max(...ratings);
    // Если все точки одинаковые — расширяем ±20.
    if (max - min < 5) {
      min -= 20;
      max += 20;
    } else {
      min -= 10;
      max += 10;
    }
    return { min, max };
  }, [points]);

  /**
   * KS-3377: вычислить Y-координату для бакета. Возвращает `null` если
   * метрика недоступна для бакета (rating + ratingEnd=null) — caller
   * пропускает точку и разрывает path.
   */
  const yForPoint = useCallback(
    (p: PrecisionTrendsResponse['points'][number]): number | null => {
      const innerH = VB_H - PAD_TOP - PAD_BOTTOM;
      if (metric === 'rating') {
        if (p.ratingEnd == null || !ratingRange) return null;
        const span = Math.max(1, ratingRange.max - ratingRange.min);
        const yNorm = (p.ratingEnd - ratingRange.min) / span;
        return PAD_TOP + (1 - yNorm) * innerH;
      }
      // accuracy 0..100 → y сверху=100%, снизу=0%.
      const yNorm = Math.max(0, Math.min(100, p.avgAccuracyPercent)) / 100;
      return PAD_TOP + (1 - yNorm) * innerH;
    },
    [metric, ratingRange],
  );

  const path = useMemo(() => {
    if (points.length === 0) return '';
    // KS-3377: gap-skip для null-бакетов в rating-режиме. После null
    // следующая точка начинается с `M` — линия разрывается.
    let d = '';
    let prev = false;
    for (const p of points) {
      const y = yForPoint(p);
      if (y == null) {
        prev = false;
        continue;
      }
      const x = xForDate(p.bucketStart);
      d += `${prev ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)} `;
      prev = true;
    }
    return d.trim();
  }, [points, xForDate, yForPoint]);

  const renderToggle = () => (
    <div className="precision-trends__toggles">
      {/* KS-3377 (ADR-082 §3 / §7 F2). Переключатель метрики
          «Точность ↔ Рейтинг». URL-state `?metric=accuracy|rating`. */}
      <div
        className="precision-trends__toggle precision-trends__toggle--metric"
        role="radiogroup"
        aria-label={t('precisionTrends.metric.label', 'Metric')}
      >
        {(['accuracy', 'rating'] as const).map((mt) => (
          <button
            key={mt}
            type="button"
            role="radio"
            aria-checked={metric === mt}
            className={`precision-trends__toggle-btn${metric === mt ? ' precision-trends__toggle-btn--active' : ''}`}
            onClick={() => setMetric(mt)}
            data-testid={`precision-trends-metric-${mt}`}
          >
            {mt === 'accuracy'
              ? t('precisionTrends.metric.accuracy', 'Accuracy')
              : t('precisionTrends.metric.rating', 'Rating')}
          </button>
        ))}
      </div>
      <div
        className="precision-trends__toggle"
        role="tablist"
        aria-label={t('precisionTrends.toggleLabel', 'Bucket size')}
      >
        {(['week', 'month'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={`precision-trends__toggle-btn${mode === m ? ' precision-trends__toggle-btn--active' : ''}`}
            onClick={() => setMode(m)}
            data-testid={`precision-trends-bucket-${m}`}
          >
            {m === 'week'
              ? t('precisionTrends.week', 'Week')
              : t('precisionTrends.month', 'Month')}
          </button>
        ))}
      </div>
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
          onClick={() => void doFetch(mode, range)}
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
      data-bucket={mode}
      data-metric={metric}
      data-points={String(points.length)}
      data-window-since={range.since.toISOString()}
      data-window-until={range.until.toISOString()}
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
        {/* KS-3377: baseline 50% актуален только для accuracy
            (середина шкалы 0..100). Для rating-режима baseline не имеет
            смысла (Y-диапазон динамический), не рендерим. */}
        {metric === 'accuracy' && (
          <line
            x1={PAD_X}
            y1={PAD_TOP + (VB_H - PAD_TOP - PAD_BOTTOM) / 2}
            x2={VB_W - PAD_X}
            y2={PAD_TOP + (VB_H - PAD_TOP - PAD_BOTTOM) / 2}
            stroke="rgba(255,255,255,0.15)"
            strokeWidth={0.5}
          />
        )}
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
        {/* KS-3040 / KS-3377: точки позиционируются по реальной дате.
            В rating-режиме null-бакеты исключены — точка не рендерится,
            line-path их тоже разрывает (gap-skip). */}
        {points.map((p, i) => {
          const y = yForPoint(p);
          if (y == null) return null; // KS-3377: skip null-rating
          const x = xForDate(p.bucketStart);
          let tooltipText: string;
          if (metric === 'rating') {
            const deltaStr =
              p.ratingDelta == null
                ? '0'
                : p.ratingDelta > 0
                  ? `+${Math.round(p.ratingDelta)}`
                  : String(Math.round(p.ratingDelta));
            tooltipText = t('precisionTrends.tooltipRating', {
              defaultValue:
                '{{date}} · rating {{rating}} ({{delta}} over period, {{attempts}} attempts)',
              date: new Date(p.bucketStart).toLocaleDateString(),
              rating: Math.round(p.ratingEnd ?? 0),
              delta: deltaStr,
              attempts: p.attempts,
            });
          } else {
            tooltipText = t('precisionTrends.tooltip', {
              defaultValue:
                '{{date}} · {{attempts}} attempts · {{preserved}} preserved · acc {{acc}}% · leak {{leak}}',
              date: new Date(p.bucketStart).toLocaleDateString(),
              attempts: p.attempts,
              preserved: p.preserved,
              acc: Math.round(p.avgAccuracyPercent),
              leak: (p.avgWdlLeakPerMove * 100).toFixed(1) + '%',
            });
          }
          return (
            <g
              key={i}
              data-testid={`precision-trends-point-${i}`}
              data-bucket-start={p.bucketStart}
              data-rating-end={
                p.ratingEnd == null ? 'null' : String(p.ratingEnd)
              }
            >
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
        {/* KS-3040: X-подписи — границы окна (since/until-1d), а не
            min/max точек. Это значит, что подпись стабильна для
            выбранного режима «Неделя/Месяц» независимо от количества
            данных. `until` — exclusive (полночь следующего после today),
            для подписи используем `until - 1д` = today. */}
        <text
          x={PAD_X}
          y={VB_H - 4}
          fontSize={8}
          fill="rgba(255,255,255,0.5)"
          data-testid="precision-trends-x-start"
        >
          {range.since.toLocaleDateString()}
        </text>
        <text
          x={VB_W - PAD_X}
          y={VB_H - 4}
          fontSize={8}
          textAnchor="end"
          fill="rgba(255,255,255,0.5)"
          data-testid="precision-trends-x-end"
        >
          {new Date(range.until.getTime() - 24 * 60 * 60 * 1000).toLocaleDateString()}
        </text>
      </svg>
    </section>
  );
}
