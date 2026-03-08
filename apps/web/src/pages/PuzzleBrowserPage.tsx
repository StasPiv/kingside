import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import type { PuzzleDto, PuzzleTheme } from '@kingside/shared';

type DifficultyLevel = 'easy' | 'medium' | 'hard' | 'expert';

const DIFFICULTY_RANGES: Record<DifficultyLevel, { min: number; max: number }> = {
  easy: { min: 0, max: 1200 },
  medium: { min: 1200, max: 1800 },
  hard: { min: 1800, max: 2400 },
  expert: { min: 2400, max: 9999 },
};

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

type PuzzleListResponse = PuzzleDto[];

const PAGE_SIZE = 20;

export function PuzzleBrowserPage() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [puzzles, setPuzzles] = useState<PuzzleDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [selectedTheme, setSelectedTheme] = useState<PuzzleTheme | ''>('');
  const [selectedDifficulty, setSelectedDifficulty] = useState<DifficultyLevel | ''>('');
  const [themeCategory, setThemeCategory] = useState<keyof typeof THEME_CATEGORIES>('tactics');

  const fetchPuzzles = useCallback(async (p: number) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      if (selectedTheme) params.append('themes[]', selectedTheme);
      if (selectedDifficulty) {
        const range = DIFFICULTY_RANGES[selectedDifficulty];
        params.set('ratingMin', String(range.min));
        params.set('ratingMax', String(range.max));
      }
      const data = await api.get<PuzzleListResponse>(`/api/puzzles?${params.toString()}`);
      setPuzzles(data);
      setTotal(data.length);
    } catch {
      setError(t('puzzleBrowser.error'));
    } finally {
      setLoading(false);
    }
  }, [selectedTheme, selectedDifficulty, t]);

  useEffect(() => {
    setPage(1);
    fetchPuzzles(1);
  }, [fetchPuzzles]);

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    fetchPuzzles(newPage);
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handleThemeSelect = (theme: PuzzleTheme) => {
    setSelectedTheme(theme === selectedTheme ? '' : theme);
  };

  const handleDifficultySelect = (diff: DifficultyLevel) => {
    setSelectedDifficulty(diff === selectedDifficulty ? '' : diff);
  };

  const difficulties: DifficultyLevel[] = ['easy', 'medium', 'hard', 'expert'];

  return (
    <div className="puzzle-browser-page">
      <h1>{t('puzzleBrowser.title')}</h1>
      {user && (
        <p className="user-info">
          {t('puzzleBrowser.yourRating', { rating: user.ratingPuzzle ?? '—' })}
        </p>
      )}

      <div className="puzzle-filters">
        <div className="filter-section">
          <h3>{t('puzzleBrowser.difficulty')}</h3>
          <div className="difficulty-filters">
            {difficulties.map((diff) => (
              <button
                key={diff}
                className={`filter-btn ${selectedDifficulty === diff ? 'active' : ''}`}
                onClick={() => handleDifficultySelect(diff)}
              >
                {t(`puzzleBrowser.difficulties.${diff}`)}
              </button>
            ))}
          </div>
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
                className={`filter-btn theme-btn ${selectedTheme === theme ? 'active' : ''}`}
                onClick={() => handleThemeSelect(theme)}
              >
                {t(`puzzleBrowser.themes.${theme}`)}
              </button>
            ))}
          </div>
        </div>
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
                  onClick={() => window.location.href = `/puzzles/${puzzle.id}`}
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
    </div>
  );
}
