import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { PuzzleGeneratorModal } from '../components/PuzzleGeneratorModal';
import { HelpButton } from '../components/HelpButton';

type GeneratedPuzzle = {
  id: string;
  fen: string;
  moves: string[];
  rating: number;
  themes: string[];
  sourceType: string;
  sourceId: string | null;
  sourceMoveNum: number | null;
  sourceMetadata: { white?: string; black?: string; event?: string } | null;
  createdAt: string;
};

const PAGE_SIZE = 20;

export function PuzzleBrowserPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [puzzles, setPuzzles] = useState<GeneratedPuzzle[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<'createdAt' | 'rating'>('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [loading, setLoading] = useState(true);
  const [showGenerator, setShowGenerator] = useState(false);

  const fetchPuzzles = useCallback(async () => {
    setLoading(true);
    try {
      const offset = (page - 1) * PAGE_SIZE;
      const data = await api.get<{ data: GeneratedPuzzle[]; total: number }>(
        `/api/puzzles/generated?limit=${PAGE_SIZE}&offset=${offset}&sort=${sort}&order=${order}`
      );
      setPuzzles(data.data ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setPuzzles([]);
    } finally {
      setLoading(false);
    }
  }, [page, sort, order]);

  useEffect(() => {
    fetchPuzzles();
  }, [fetchPuzzles]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleSort = (field: 'createdAt' | 'rating') => {
    if (sort === field) {
      setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(field);
      setOrder('desc');
    }
    setPage(1);
  };

  return (
    <div className="puzzle-browser-page">
      <h1>{t('puzzleBrowser.title')}<HelpButton section="puzzles" /></h1>

      {/* Toolbar */}
      <div className="puzzle-toolbar">
        <div className="puzzle-toolbar__left">
          <button className="generate-puzzles-btn" onClick={() => setShowGenerator(true)}>
            {t('puzzleGenerator.fromPgn', 'Generate from PGN')}
          </button>
          {total > 0 && (
            <button
              className="puzzle-delete-all-btn"
              onClick={async () => {
                if (!confirm(t('puzzleBrowser.confirmDeleteAll', 'Delete all generated puzzles?'))) return;
                try {
                  await api.delete('/api/puzzles/generated/all');
                  setPuzzles([]);
                  setTotal(0);
                  setPage(1);
                } catch { /* ignore */ }
              }}
            >
              {t('puzzleBrowser.deleteAll', 'Delete All')}
            </button>
          )}
        </div>
        <div className="puzzle-toolbar__right">
          <span className="puzzle-toolbar__total">{total} puzzles</span>
          <button
            className={`puzzle-sort-btn${sort === 'createdAt' ? ' active' : ''}`}
            onClick={() => toggleSort('createdAt')}
          >
            {t('puzzleBrowser.sortDate', 'Date')} {sort === 'createdAt' && (order === 'desc' ? '↓' : '↑')}
          </button>
          <button
            className={`puzzle-sort-btn${sort === 'rating' ? ' active' : ''}`}
            onClick={() => toggleSort('rating')}
          >
            {t('puzzleBrowser.sortRating', 'Rating')} {sort === 'rating' && (order === 'desc' ? '↓' : '↑')}
          </button>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="loading">{t('common.loading')}</div>
      ) : puzzles.length === 0 ? (
        <div className="puzzle-empty">
          <p>{t('puzzleBrowser.noGenerated', 'No generated puzzles yet.')}</p>
        </div>
      ) : (
        <div className="puzzle-list">
          {puzzles.map((puzzle) => (
            <div key={puzzle.id} className="puzzle-card">
              <div className="puzzle-card-header">
                <span className="puzzle-card-title">
                  {puzzle.sourceMetadata?.white && puzzle.sourceMetadata?.black
                    ? `${puzzle.sourceMetadata.white} vs ${puzzle.sourceMetadata.black}`
                    : puzzle.sourceMetadata?.event || `#${puzzle.id.slice(0, 6)}`}
                  {puzzle.sourceMoveNum ? `, move ${puzzle.sourceMoveNum}` : ''}
                </span>
                <span className="puzzle-rating">{puzzle.rating}</span>
              </div>
              <div className="puzzle-card-themes">
                {puzzle.themes.slice(0, 3).map((theme) => (
                  <span key={theme} className="puzzle-theme-tag">
                    {t(`puzzleBrowser.themes.${theme}`, theme)}
                  </span>
                ))}
                {puzzle.themes.length > 3 && (
                  <span className="puzzle-theme-tag more">+{puzzle.themes.length - 3}</span>
                )}
              </div>
              <div className="puzzle-card-actions">
                <button
                  className="puzzle-solve-btn"
                  onClick={() => navigate(`/puzzle/${puzzle.id}?source=generated`)}
                >
                  {t('puzzleBrowser.solve')}
                </button>
                <button
                  className="puzzle-delete-btn"
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      await api.delete(`/api/puzzles/generated/${puzzle.id}`);
                      setPuzzles((prev) => prev.filter((p) => p.id !== puzzle.id));
                      setTotal((n) => n - 1);
                    } catch { /* ignore */ }
                  }}
                  title={t('common.delete', 'Delete')}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="puzzle-pagination">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t('puzzleBrowser.prev', 'Prev')}
          </button>
          <span className="puzzle-pagination__info">
            Page {page} of {totalPages}
          </span>
          <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            {t('puzzleBrowser.next', 'Next')}
          </button>
        </div>
      )}

      {showGenerator && (
        <PuzzleGeneratorModal onClose={() => { setShowGenerator(false); fetchPuzzles(); }} />
      )}
    </div>
  );
}
