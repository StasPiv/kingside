import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PrecisionBreakdownsResponse } from '@kingside/shared';
import { api } from '../../api';

/**
 * KS-2728 / ADR-056 §2.3 + §4 (Уровень В). Две карточки:
 * 1. Распределение по фазе игры (opening/middlegame/endgame) —
 *    bar-chart с числом попыток и средней accuracy на бар.
 * 2. Слабые темы — top-10 тем с самой низкой accuracy
 *    (отсортированы по `weakness DESC` со стороны бэкенда).
 *
 * Источник — `GET /precision/breakdowns/me?since=` (бэкенд KS-2727,
 * api rev 163). Контракт `PrecisionBreakdownsResponse` из @kingside/shared.
 *
 * Состояния:
 *   loading: skeleton-плашки.
 *   error: «Не удалось загрузить» + retry.
 *   empty: byPhase=[]&byTheme=[] → блок не рендерится (родитель сам
 *          скрывает; здесь возвращаем сообщение в дизайне).
 *   ready: две колонки.
 */

const PHASE_ORDER: Array<'opening' | 'middlegame' | 'endgame'> = [
  'opening',
  'middlegame',
  'endgame',
];

export interface PrecisionBreakdownsProps {
  /** DI для тестов. */
  fetcher?: () => Promise<PrecisionBreakdownsResponse>;
}

export function PrecisionBreakdowns({ fetcher }: PrecisionBreakdownsProps = {}) {
  const { t } = useTranslation();
  const [data, setData] = useState<PrecisionBreakdownsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<boolean>(false);

  const doFetch = useCallback(async () => {
    setLoading(true);
    setError(false);
    const get =
      fetcher ??
      (() => api.get<PrecisionBreakdownsResponse>('/precision/breakdowns/me'));
    try {
      const res = await get();
      setData(res);
    } catch {
      setError(true);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void doFetch();
  }, [doFetch]);

  if (loading) {
    return (
      <section
        className="precision-breakdowns"
        data-testid="precision-breakdowns"
        data-state="loading"
      >
        <h2 className="precision-breakdowns__title">
          {t('precisionBreakdowns.title', 'Breakdowns')}
        </h2>
        <div
          className="precision-breakdowns__skeleton"
          data-testid="precision-breakdowns-skeleton"
        />
      </section>
    );
  }

  if (error) {
    return (
      <section
        className="precision-breakdowns"
        data-testid="precision-breakdowns"
        data-state="error"
      >
        <h2 className="precision-breakdowns__title">
          {t('precisionBreakdowns.title', 'Breakdowns')}
        </h2>
        <p className="precision-breakdowns__msg">
          {t(
            'precisionBreakdowns.loadError',
            'Could not load breakdowns.',
          )}
        </p>
        <button
          type="button"
          className="precision-breakdowns__retry"
          onClick={() => void doFetch()}
          data-testid="precision-breakdowns-retry"
        >
          {t('common.retry', 'Retry')}
        </button>
      </section>
    );
  }

  if (!data || (data.byPhase.length === 0 && data.byTheme.length === 0)) {
    return (
      <section
        className="precision-breakdowns"
        data-testid="precision-breakdowns"
        data-state="empty"
      >
        <h2 className="precision-breakdowns__title">
          {t('precisionBreakdowns.title', 'Breakdowns')}
        </h2>
        <p
          className="precision-breakdowns__msg"
          data-testid="precision-breakdowns-empty"
        >
          {t(
            'precisionBreakdowns.empty',
            'Play more attempts to see breakdowns by phase and theme.',
          )}
        </p>
      </section>
    );
  }

  // Максимум attempts по фазам — для нормализации ширины бара.
  const phaseMaxAttempts = Math.max(
    1,
    ...data.byPhase.map((p) => p.attempts),
  );

  return (
    <section
      className="precision-breakdowns"
      data-testid="precision-breakdowns"
      data-state="ready"
    >
      <h2 className="precision-breakdowns__title">
        {t('precisionBreakdowns.title', 'Breakdowns')}
      </h2>
      <div className="precision-breakdowns__grid">
        {/* Phase-карточка. */}
        <div
          className="precision-breakdowns__card"
          data-testid="precision-breakdowns-phase"
        >
          <h3 className="precision-breakdowns__card-title">
            {t('precisionBreakdowns.phase.title', 'By game phase')}
          </h3>
          {data.byPhase.length === 0 ? (
            <p className="precision-breakdowns__msg">
              {t('precisionBreakdowns.phase.empty', 'No data yet.')}
            </p>
          ) : (
            <ul className="precision-breakdowns__bars">
              {PHASE_ORDER.map((phase) => {
                const item = data.byPhase.find((p) => p.phase === phase);
                if (!item) return null;
                const widthPct = (item.attempts / phaseMaxAttempts) * 100;
                return (
                  <li
                    key={phase}
                    className="precision-breakdowns__bars-row"
                    data-testid={`precision-breakdowns-phase-${phase}`}
                    data-attempts={String(item.attempts)}
                    data-accuracy={String(Math.round(item.avgAccuracyPercent))}
                  >
                    <span className="precision-breakdowns__bars-label">
                      {t(
                        `precisionBreakdowns.phase.${phase}`,
                        phase.charAt(0).toUpperCase() + phase.slice(1),
                      )}
                    </span>
                    <span className="precision-breakdowns__bars-track">
                      <span
                        className={`precision-breakdowns__bars-fill precision-breakdowns__bars-fill--${phase}`}
                        style={{ width: `${widthPct.toFixed(1)}%` }}
                      />
                    </span>
                    <span className="precision-breakdowns__bars-meta">
                      {item.attempts} · {Math.round(item.avgAccuracyPercent)}%
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Слабые темы — top-10 (бэкенд уже отсортировал по weakness DESC). */}
        <div
          className="precision-breakdowns__card"
          data-testid="precision-breakdowns-themes"
        >
          <h3 className="precision-breakdowns__card-title">
            {t('precisionBreakdowns.themes.title', 'Weakest themes')}
          </h3>
          {data.byTheme.length === 0 ? (
            <p className="precision-breakdowns__msg">
              {t('precisionBreakdowns.themes.empty', 'No data yet.')}
            </p>
          ) : (
            <ul className="precision-breakdowns__themes">
              {data.byTheme.slice(0, 10).map((th) => (
                <li
                  key={th.theme}
                  className="precision-breakdowns__themes-row"
                  data-testid={`precision-breakdowns-theme-${th.theme}`}
                  data-attempts={String(th.attempts)}
                  data-accuracy={String(Math.round(th.avgAccuracyPercent))}
                >
                  <span className="precision-breakdowns__themes-label">
                    {th.theme}
                  </span>
                  <span className="precision-breakdowns__themes-track">
                    <span
                      className="precision-breakdowns__themes-fill"
                      style={{ width: `${Math.min(100, th.weakness).toFixed(1)}%` }}
                    />
                  </span>
                  <span className="precision-breakdowns__themes-meta">
                    {th.attempts} · {Math.round(th.avgAccuracyPercent)}%
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
