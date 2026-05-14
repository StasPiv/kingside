import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
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
  // KS-3005 (ADR-065 §5.1.3, §6.5, F4): средний балл и распределение
  // по звёздам для карточки «Средний балл». Поля приходят с B4-эндпоинта
  // `/precision/stats/me`. `null`/`undefined` — карточка не рендерится
  // (legacy/нет attempts со score).
  avgScore?: number | null;
  avgScorePct?: number | null;
  scoreDistribution?: {
    stars1: number;
    stars2: number;
    stars3: number;
    stars4: number;
    stars5: number;
  };
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
          {/* KS-3005 (ADR-065 §5.1.3, F4): 5-я карточка «Средний балл».
              Рендерится только если backend B4 вернул `avgScore !== null`.
              Это сохраняет совместимость с ADR-056 §2.1 — 4 старых
              карточки остаются на месте, новая просто добавляется. */}
          {stats.avgScore != null && (
            <AvgScoreCard
              avgScore={stats.avgScore}
              distribution={stats.scoreDistribution}
              t={t}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * KS-3005 (ADR-065 §5.1.3): карточка «Средний балл» — `4.2/5` + stack-bar
 * распределения по звёздам.
 *
 * Stack-bar — горизонтальная полоса, разбитая на 5 сегментов (1★…5★) с
 * шириной пропорционально count'у в `scoreDistribution`. Цвета сегментов
 * — по §4.2 (red/orange/amber/lime/emerald). Пустой stack-bar (всего 0)
 * — показываем нейтральную dashed-плашку, чтобы карточка не выглядела
 * сломанной (например, ранний state: avgScore посчитался для одной
 * попытки, distribution ещё пуст).
 */
const STARS_ORDER = [
  { key: 'stars1', label: '1★', tone: '#ef4444' },
  { key: 'stars2', label: '2★', tone: '#f97316' },
  { key: 'stars3', label: '3★', tone: '#f59e0b' },
  { key: 'stars4', label: '4★', tone: '#84cc16' },
  { key: 'stars5', label: '5★', tone: '#10b981' },
] as const;

interface AvgScoreCardProps {
  avgScore: number;
  distribution?: {
    stars1: number;
    stars2: number;
    stars3: number;
    stars4: number;
    stars5: number;
  };
  t: TFunction;
}

function AvgScoreCard({ avgScore, distribution, t }: AvgScoreCardProps) {
  const dist = distribution ?? {
    stars1: 0,
    stars2: 0,
    stars3: 0,
    stars4: 0,
    stars5: 0,
  };
  const total =
    dist.stars1 + dist.stars2 + dist.stars3 + dist.stars4 + dist.stars5;
  const avgRounded = Number.isFinite(avgScore)
    ? Math.round(avgScore * 10) / 10
    : 0;
  // «4.2/5» — фиксируем один знак после запятой, чтобы цифра не прыгала
  // при близких изменениях (3.999 → 4.0 vs 3.95 → 3.9).
  const avgText = `${avgRounded.toFixed(1)}/5`;

  return (
    <div
      className="precision-stats__cell precision-stats__cell--avg-score"
      data-testid="precision-stats-avg-score"
      data-avg-score={String(avgRounded)}
      data-total={String(total)}
    >
      <div className="precision-stats__value">{avgText}</div>
      <div className="precision-stats__label">
        {t('precision.stats.avgScore', 'Average score')}
      </div>
      {total > 0 ? (
        <div
          className="precision-stats__stack-bar"
          data-testid="precision-stats-avg-score-bar"
          role="img"
          aria-label={t(
            'precision.stats.avgScoreBarAria',
            'Distribution of attempts by stars (1★ to 5★)',
          )}
        >
          {STARS_ORDER.map((s) => {
            const count = dist[s.key];
            const pct = total > 0 ? (count / total) * 100 : 0;
            return (
              <span
                key={s.key}
                className="precision-stats__stack-seg"
                data-testid={`precision-stats-avg-score-seg-${s.key}`}
                data-count={String(count)}
                style={{
                  width: `${pct}%`,
                  background: s.tone,
                }}
                title={`${s.label}: ${count}`}
              />
            );
          })}
        </div>
      ) : (
        <div className="precision-stats__hint">
          {t(
            'precision.stats.avgScoreNoDist',
            'No graded attempts yet',
          )}
        </div>
      )}
    </div>
  );
}
