import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSavedAnalyses } from '../../hooks/useSavedAnalyses';
import type { SavedAnalysis } from '../../hooks/useSavedAnalyses';

export function WorkshopAnalysisList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { getAll, remove } = useSavedAnalyses();
  const [analyses, setAnalyses] = useState<SavedAnalysis[]>([]);

  const refresh = useCallback(() => {
    setAnalyses(getAll());
  }, [getAll]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (analyses.length === 0) return null;

  const handleOpen = (analysis: SavedAnalysis) => {
    navigate('/analysis', {
      state: { pgn: analysis.pgn, localId: analysis.id, title: analysis.title },
    });
  };

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    remove(id);
    refresh();
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return (
    <section className="workshop-section-block">
      <h2 className="workshop-section-block__title">{t('workshop.myAnalyses.title')}</h2>
      <div className="workshop-analyses-list">
        {analyses.map((analysis) => (
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
                {(analysis.whitePgn || analysis.blackPgn) && (
                  <span className="workshop-analysis-item__players">
                    {analysis.whitePgn ?? '?'} vs {analysis.blackPgn ?? '?'}
                  </span>
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
    </section>
  );
}
