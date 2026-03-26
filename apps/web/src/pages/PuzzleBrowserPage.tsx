import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import type { PuzzleDto, PuzzleTheme } from '@kingside/shared';
import { PuzzleGeneratorModal } from '../components/PuzzleGeneratorModal';

const THEME_CATEGORIES = {
  tactics: [
    'fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck',
    'attraction', 'deflection', 'interference', 'intermezzo',
    'sacrifice', 'clearance', 'capturingDefender', 'zugzwang',
  ] as PuzzleTheme[],
  mates: [
    'mate', 'mateIn1', 'mateIn2', 'mateIn3', 'mateIn4', 'mateIn5',
    'backRankMate', 'smotheredMate', 'arabianMate', 'bodenMate',
    'dovetailMate', 'doubleBishopMate', 'hookMate',
  ] as PuzzleTheme[],
  endgames: [
    'endgame', 'pawnEndgame', 'rookEndgame', 'bishopEndgame',
    'knightEndgame', 'queenEndgame', 'queenRookEndgame',
  ] as PuzzleTheme[],
  other: [
    'opening', 'middlegame', 'advancedPawn', 'attackingF2F7',
    'kingsideAttack', 'queensideAttack', 'castling', 'enPassant',
    'promotion', 'underPromotion', 'exposedKing', 'hangingPiece',
    'trappedPiece', 'defensiveMove', 'quietMove',
    'short', 'long', 'veryLong', 'oneMove', 'crushing',
    'advantage', 'equality', 'master', 'masterVsMaster', 'superGM',
    'xRayAttack', 'anapierce',
  ] as PuzzleTheme[],
};

const PAGE_SIZE = 20;

type GeneratedPuzzle = {
  id: string;
  fen: string;
  moves: string[];
  rating: number;
  themes: string[];
  sourceType: string;
  sourceId: string | null;
  createdAt: string;
};

export function PuzzleBrowserPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState<'library' | 'generated'>('library');
  const [puzzles, setPuzzles] = useState<PuzzleDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showGenerator, setShowGenerator] = useState(false);

  const [selectedThemes, setSelectedThemes] = useState<Set<PuzzleTheme>>(new Set());
  const [ratingMin, setRatingMin] = useState(600);
  const [ratingMax, setRatingMax] = useState(2800);
  const [ratingEnabled, setRatingEnabled] = useState(false);
  const [themeCategory, setThemeCategory] = useState<keyof typeof THEME_CATEGORIES>('tactics');

  const fetchPuzzles = useCallback(async (p: number) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      if (selectedThemes.size > 0) params.set('themes', Array.from(selectedThemes).join(','));
      if (ratingEnabled) {
        params.set('ratingMin', String(ratingMin));
        params.set('ratingMax', String(ratingMax));
      }
      const data = await api.get<PuzzleDto[]>(`/api/puzzles?${params.toString()}`);
      const list = Array.isArray(data) ? data : [];
      setPuzzles(list);
      setTotal(list.length);
    } catch {
      setError(t('puzzleBrowser.error'));
    } finally {
      setLoading(false);
    }
  }, [selectedThemes, ratingEnabled, ratingMin, ratingMax, t]);

  // Generated puzzles
  const [genPuzzles, setGenPuzzles] = useState<GeneratedPuzzle[]>([]);
  const [genTotal, setGenTotal] = useState(0);
  const [genLoading, setGenLoading] = useState(false);

  const fetchGenerated = useCallback(async () => {
    setGenLoading(true);
    try {
      const data = await api.get<{ data: GeneratedPuzzle[]; total: number }>('/api/puzzles/generated?limit=50');
      setGenPuzzles(data.data ?? []);
      setGenTotal(data.total ?? 0);
    } catch {
      setGenPuzzles([]);
    } finally {
      setGenLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'library') {
      setPage(1);
      fetchPuzzles(1);
    } else {
      fetchGenerated();
    }
  }, [fetchPuzzles, activeTab, fetchGenerated]);

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    fetchPuzzles(newPage);
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handleThemeToggle = (theme: PuzzleTheme) => {
    setSelectedThemes((prev) => {
      const next = new Set(prev);
      if (next.has(theme)) next.delete(theme); else next.add(theme);
      return next;
    });
  };

  const handleClearFilters = () => {
    setSelectedThemes(new Set());
    setRatingEnabled(false);
    setRatingMin(600);
    setRatingMax(2800);
  };

  return (
    <div className="puzzle-browser-page">
      <h1>{t('puzzleBrowser.title')}</h1>
      {user && (
        <p className="user-info">
          {t('puzzleBrowser.yourRating', { rating: user.ratingPuzzle ?? '—' })}
        </p>
      )}

      <div className="puzzle-browser-tabs">
        <button className={`puzzle-browser-tab${activeTab === 'library' ? ' active' : ''}`} onClick={() => setActiveTab('library')}>
          {t('puzzleBrowser.library', 'Library')}
        </button>
        <button className={`puzzle-browser-tab${activeTab === 'generated' ? ' active' : ''}`} onClick={() => setActiveTab('generated')}>
          {t('puzzleBrowser.generated', 'Generated')} {genTotal > 0 && `(${genTotal})`}
        </button>
      </div>

      {activeTab === 'library' && (
      <>
      <div className="puzzle-filters">
        <div className="filter-section">
          <h3>{t('puzzleBrowser.rating', 'Rating Range')}</h3>
          <label className="puzzle-filter-toggle">
            <input type="checkbox" checked={ratingEnabled} onChange={(e) => setRatingEnabled(e.target.checked)} />
            {t('puzzleBrowser.filterByRating', 'Filter by rating')}
          </label>
          {ratingEnabled && (
            <div className="puzzle-rating-range">
              <input type="range" min={600} max={2800} step={50} value={ratingMin} onChange={(e) => setRatingMin(Math.min(Number(e.target.value), ratingMax - 50))} />
              <input type="range" min={600} max={2800} step={50} value={ratingMax} onChange={(e) => setRatingMax(Math.max(Number(e.target.value), ratingMin + 50))} />
              <span className="puzzle-rating-range__label">{ratingMin} — {ratingMax}</span>
            </div>
          )}
        </div>

        <div className="filter-section">
          <h3>{t('puzzleBrowser.theme')}</h3>
          <div className="theme-category-tabs">
            {(Object.keys(THEME_CATEGORIES) as (keyof typeof THEME_CATEGORIES)[]).map((cat) => (
              <button
                key={cat}
                className={`tc-tab ${themeCategory === cat ? 'active' : ''}`}
                onClick={() => setThemeCategory(cat)}
              >
                {t(`puzzleBrowser.themeCategories.${cat}`)}
              </button>
            ))}
          </div>
          <div className="theme-filters">
            {THEME_CATEGORIES[themeCategory].map((theme) => (
              <button
                key={theme}
                className={`filter-btn theme-btn ${selectedThemes.has(theme) ? 'active' : ''}`}
                onClick={() => handleThemeToggle(theme)}
              >
                {t(`puzzleBrowser.themes.${theme}`)}
              </button>
            ))}
          </div>
          {selectedThemes.size > 0 && (
            <div className="puzzle-selected-themes">
              {Array.from(selectedThemes).map((theme) => (
                <span key={theme} className="puzzle-theme-chip">
                  {t(`puzzleBrowser.themes.${theme}`)}
                  <button onClick={() => handleThemeToggle(theme)}>×</button>
                </span>
              ))}
            </div>
          )}
        </div>

        {(selectedThemes.size > 0 || ratingEnabled) && (
          <button className="puzzle-clear-filters" onClick={handleClearFilters}>
            {t('puzzleBrowser.clearFilters', 'Clear Filters')}
          </button>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="loading">{t('common.loading')}</div>
      ) : (
        <>
          <div className="puzzle-results-info">
            {t('puzzleBrowser.found', { count: total })}
          </div>

          <div className="puzzle-list">
            {puzzles.map((puzzle) => (
              <div key={puzzle.id} className="puzzle-card">
                <div className="puzzle-card-header">
                  <span className="puzzle-id">#{puzzle.id}</span>
                  <span className="puzzle-rating">{puzzle.rating}</span>
                </div>
                <div className="puzzle-card-themes">
                  {puzzle.themes.slice(0, 3).map((theme) => (
                    <span key={theme} className="puzzle-theme-tag">
                      {t(`puzzleBrowser.themes.${theme}`)}
                    </span>
                  ))}
                  {puzzle.themes.length > 3 && (
                    <span className="puzzle-theme-tag more">+{puzzle.themes.length - 3}</span>
                  )}
                </div>
                <button
                  className="puzzle-solve-btn"
                  onClick={() => navigate(`/puzzle/${puzzle.id}`)}
                >
                  {t('puzzleBrowser.solve')}
                </button>
              </div>
            ))}
          </div>

          {puzzles.length === 0 && !loading && (
            <div className="puzzle-empty">{t('puzzleBrowser.empty')}</div>
          )}

          {totalPages > 1 && (
            <div className="puzzle-pagination">
              <button
                disabled={page <= 1}
                onClick={() => handlePageChange(page - 1)}
              >
                {t('puzzleBrowser.prev')}
              </button>
              <span className="page-info">
                {t('puzzleBrowser.page', { current: page, total: totalPages })}
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => handlePageChange(page + 1)}
              >
                {t('puzzleBrowser.next')}
              </button>
            </div>
          )}
        </>
      )}
      </>
      )}

      {activeTab === 'generated' && (
        genLoading ? (
          <div className="loading">{t('common.loading')}</div>
        ) : genPuzzles.length === 0 ? (
          <div className="puzzle-empty">
            <p>{t('puzzleBrowser.noGenerated', 'No generated puzzles yet.')}</p>
          </div>
        ) : (
          <div className="puzzle-list">
            {genPuzzles.map((puzzle) => (
              <div key={puzzle.id} className="puzzle-card">
                <div className="puzzle-card-header">
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
                        setGenPuzzles((prev) => prev.filter((p) => p.id !== puzzle.id));
                        setGenTotal((n) => n - 1);
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
        )
      )}

      {activeTab === 'generated' && !genLoading && (
        <div className="puzzle-generator-action">
          <button className="generate-puzzles-btn" onClick={() => setShowGenerator(true)}>
            {t('puzzleGenerator.fromPgn', 'Generate from PGN')}
          </button>
          {genTotal > 0 && (
            <button
              className="puzzle-delete-all-btn"
              onClick={async () => {
                if (!confirm(t('puzzleBrowser.confirmDeleteAll', 'Delete all generated puzzles?'))) return;
                try {
                  await api.delete('/api/puzzles/generated/all');
                  setGenPuzzles([]);
                  setGenTotal(0);
                } catch { /* ignore */ }
              }}
            >
              {t('puzzleBrowser.deleteAll', 'Delete All')}
            </button>
          )}
        </div>
      )}

      {showGenerator && (
        <PuzzleGeneratorModal onClose={() => { setShowGenerator(false); if (activeTab === 'generated') fetchGenerated(); }} />
      )}
    </div>
  );
}
