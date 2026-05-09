import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { AnalysisResponse } from '@kingside/shared';

import { api } from '../api';

/**
 * KS-2666 / ADR-051 §3 — read-only страница публичного анализа.
 *
 * URL `/analysis/public/:id`. Backend `GET /analyses/public/:id`
 * (KS-2602) отдаёт анализ без auth, если `isPublic=true`. Если
 * `isPublic=false` или анализа нет — 404.
 *
 * Минимальный UI: заголовок, PGN в `<pre>` для текстового просмотра.
 * Полный AnalysisPage не используется — он завязан на авторские
 * операции (autosave, аннотации, навигация по дереву). Для read-only
 * хватает PGN. Если в будущем нужна интерактивная доска для гостей —
 * выделим общий read-only renderer (отдельная задача).
 */

export function PublicAnalysisPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<AnalysisResponse>(`/analyses/public/${id}`)
      .then((res) => {
        if (cancelled) return;
        setAnalysis(res);
      })
      .catch(() => {
        if (cancelled) return;
        setError(
          t(
            'analysis.public.notFound',
            'Analysis not found or is private',
          ),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  if (loading) {
    return (
      <div
        className="public-analysis-page public-analysis-page--loading"
        data-testid="public-analysis-loading"
      >
        {t('common.loading', 'Loading…')}
      </div>
    );
  }

  if (error || !analysis) {
    return (
      <div
        className="public-analysis-page public-analysis-page--error"
        data-testid="public-analysis-not-found"
      >
        <h1>{error ?? t('analysis.public.notFound', 'Not found')}</h1>
        <Link to="/" data-testid="public-analysis-home-link">
          {t('common.backToHome', 'Back to home')}
        </Link>
      </div>
    );
  }

  return (
    <div
      className="public-analysis-page"
      data-testid="public-analysis-page"
    >
      <header className="public-analysis-page__header">
        <h1 data-testid="public-analysis-title">{analysis.title}</h1>
        <p className="public-analysis-page__hint">
          {t(
            'analysis.public.readOnlyHint',
            'Read-only public view. Sign in to create your own analyses.',
          )}
        </p>
      </header>
      <pre
        className="public-analysis-page__pgn"
        data-testid="public-analysis-pgn"
      >
        {analysis.pgn ?? ''}
      </pre>
    </div>
  );
}
