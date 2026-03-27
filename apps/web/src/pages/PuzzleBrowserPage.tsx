import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { PuzzleGeneratorModal } from '../components/PuzzleGeneratorModal';

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

export function PuzzleBrowserPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [genPuzzles, setGenPuzzles] = useState<GeneratedPuzzle[]>([]);
  const [genTotal, setGenTotal] = useState(0);
  const [genLoading, setGenLoading] = useState(true);
  const [showGenerator, setShowGenerator] = useState(false);

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
    fetchGenerated();
  }, [fetchGenerated]);

  return (
    <div className="puzzle-browser-page">
      <h1>{t('puzzleBrowser.title')}</h1>
      {user && (
        <p className="user-info">
          {t('puzzleBrowser.yourRating', { rating: user.ratingPuzzle ?? '—' })}
        </p>
      )}

      {genLoading ? (
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
      )}

      {!genLoading && (
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
        <PuzzleGeneratorModal onClose={() => { setShowGenerator(false); fetchGenerated(); }} />
      )}
    </div>
  );
}
