import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { AnalysisListItem } from '@kingside/shared';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../api';

const PAGE_SIZE = 20;

export function WorkshopAnalysisList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [allAnalyses, setAllAnalyses] = useState<AnalysisListItem[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    setError('');
    api.get<AnalysisListItem[]>('/api/analyses')
      .then((data) => setAllAnalyses(data))
      .catch(() => setError(t('common.loadError', 'Failed to load analyses')))
      .finally(() => setLoading(false));
  }, [user, t]);

  const visibleAnalyses = allAnalyses.slice(0, visibleCount);
  const hasMore = visibleCount < allAnalyses.length;

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    if (!hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore) {
          setLoadingMore(true);
          setVisibleCount((prev) => prev + PAGE_SIZE);
          setLoadingMore(false);
        }
      },
      { threshold: 0.1 },
    );

    const el = sentinelRef.current;
    if (el) observer.observe(el);
    return () => { if (el) observer.unobserve(el); };
  }, [hasMore, loadingMore]);

  const handleOpen = (analysis: AnalysisListItem) => {
    navigate('/analysis/' + analysis.id, {
      state: {
        breadcrumbRootTitle: t('workshop.myAnalyses.title'),
        breadcrumbRootUrl: '/workshop',
      },
    });
  };

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    api.delete(`/api/analyses/${id}`)
      .then(() => setAllAnalyses((prev) => prev.filter((a) => a.id !== id)))
      .catch(() => {});
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return (
    <section className="workshop-section-block">
      <h2 className="workshop-section-block__title">{t('workshop.myAnalyses.title')}</h2>
      {!user ? (
        <p className="workshop-section-block__empty">
          {t('workshop.myAnalyses.loginRequired', 'Sign in to save your analyses')}
        </p>
      ) : loading ? (
        <p className="workshop-section-block__empty">{t('common.loading')}</p>
      ) : error ? (
        <p className="workshop-section-block__empty">{error}</p>
      ) : allAnalyses.length === 0 ? (
        <p className="workshop-section-block__empty">{t('workshop.myAnalyses.empty')}</p>
      ) : (
        <>
          <div className="workshop-analyses-list">
            {visibleAnalyses.map((analysis) => (
              <div
                key={analysis.id}
                className="workshop-analysis-item"
                onClick={() => handleOpen(analysis)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && handleOpen(analysis)}
              >
                <div className="workshop-analysis-item__main">
                  <span className="workshop-analysis-item__title">{analysis.title}</span>
                  <div className="workshop-analysis-item__meta">
                    <span className="workshop-analysis-item__date">{formatDate(analysis.createdAt)}</span>
                    {analysis.opening && (
                      <span className="workshop-analysis-item__opening">{analysis.opening}</span>
                    )}
                  </div>
                </div>
                <button
                  className="workshop-analysis-item__delete"
                  onClick={(e) => handleDelete(e, analysis.id)}
                  title={t('workshop.myAnalyses.delete')}
                  aria-label={t('workshop.myAnalyses.delete')}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {hasMore && (
            <div ref={sentinelRef} className="games-load-more">
              {loadingMore && <span>{t('common.loading')}</span>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
