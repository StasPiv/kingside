import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
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
  isPublic?: boolean;
  userId?: string;
  createdAt: string;
};

const PAGE_SIZE = 20;

export function PuzzleBrowserPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [searchParams, setSearchParams] = useSearchParams();
  const mineParam = searchParams.get('mine') === 'true';

  const [puzzles, setPuzzles] = useState<GeneratedPuzzle[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<'createdAt' | 'rating'>('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [loading, setLoading] = useState(true);
  const [showGenerator, setShowGenerator] = useState(false);
  const [mine, setMine] = useState(mineParam);

  const fetchPuzzles = useCallback(async () => {
    setLoading(true);
    try {
      const offset = (page - 1) * PAGE_SIZE;
      const mineQuery = mine ? '&mine=true' : '';
      const data = await api.get<{ data: GeneratedPuzzle[]; total: number }>(
        `/api/puzzles/generated?limit=${PAGE_SIZE}&offset=${offset}&sort=${sort}&order=${order}${mineQuery}`
      );
      setPuzzles(data.data ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setPuzzles([]);
    } finally {
      setLoading(false);
    }
  }, [page, sort, order, mine]);

  const toggleMine = (val: boolean) => {
    setMine(val);
    setPage(1);
    setSearchParams(val ? { mine: 'true' } : {});
  };

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

      {/* Tabs */}
      <div className="puzzle-browser-tabs">
        <button className={`puzzle-browser-tab${!mine ? ' active' : ''}`} onClick={() => toggleMine(false)}>
          {t('puzzleBrowser.allPuzzles', 'All puzzles')}
        </button>
        <button className={`puzzle-browser-tab${mine ? ' active' : ''}`} onClick={() => toggleMine(true)}>
          {t('puzzleBrowser.myPuzzles', 'My puzzles')}
        </button>
        {user && (
          <Link to="/puzzles/stats" className="puzzle-browser-tab">
            {t('puzzleStats.title', 'Statistics')}
          </Link>
        )}
      </div>

      {/* Toolbar */}
      <div className="puzzle-toolbar">
        <div className="puzzle-toolbar__left">
          <button className="generate-puzzles-btn" onClick={() => setShowGenerator(true)}>
            {t('puzzleGenerator.fromPgn', 'Generate from PGN')}
          </button>
          {mine && total > 0 && (
            <button
              className="puzzle-delete-all-btn"
              onClick={async () => {
                if (!confirm(t('puzzleBrowser.confirmDeleteMine', 'Delete all your {{count}} puzzles?', { count: total }))) return;
                try {
                  await api.delete('/api/puzzles/generated/all');
                  setPuzzles([]);
                  setTotal(0);
                  setPage(1);
                } catch { /* ignore */ }
              }}
            >
              {t('puzzleBrowser.deleteMine', 'Delete my puzzles ({{count}})', { count: total })}
            </button>
          )}
          {mine && total > 0 && (
            <button
              className="puzzle-publish-all-btn"
              onClick={async () => {
                try {
                  await api.patch('/api/puzzles/generated/publish-all', {});
                  fetchPuzzles();
                } catch { /* ignore */ }
              }}
            >
              {t('puzzleBrowser.publishAll', 'Publish all')}
            </button>
          )}
        </div>
        <div className="puzzle-toolbar__right">
          <span className="puzzle-toolbar__total">{t('puzzleBrowser.totalCount', '{{count}} puzzles', { count: total })}</span>
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
                  {puzzle.sourceMoveNum ? `, ${t('puzzleBrowser.moveNum', 'move {{num}}', { num: puzzle.sourceMoveNum })}` : ''}
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
                {puzzle.userId === user?.id && (
                  <button
                    className={`puzzle-share-btn${puzzle.isPublic ? ' shared' : ''}`}
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        await api.patch(`/api/puzzles/generated/${puzzle.id}`, { isPublic: !puzzle.isPublic });
                        setPuzzles((prev) => prev.map((p) => p.id === puzzle.id ? { ...p, isPublic: !p.isPublic } : p));
                      } catch { /* ignore */ }
                    }}
                    title={puzzle.isPublic ? t('puzzleBrowser.unpublish', 'Make private') : t('puzzleBrowser.publish', 'Publish')}
                  >
                    {puzzle.isPublic ? '🌐' : '🔒'}
                  </button>
                )}
                {puzzle.userId === user?.id && (
                  <button
                    className="puzzle-delete-btn"
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        await api.delete(`/api/puzzles/${puzzle.id}`);
                        setPuzzles((prev) => prev.filter((p) => p.id !== puzzle.id));
                        setTotal((n) => n - 1);
                      } catch { /* ignore */ }
                    }}
                    title={t('common.delete', 'Delete')}
                  >
                    ×
                  </button>
                )}
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
            {t('puzzleBrowser.pageInfo', 'Page {{current}} of {{total}}', { current: page, total: totalPages })}
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
