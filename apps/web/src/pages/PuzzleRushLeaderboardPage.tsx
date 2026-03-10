import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { puzzleApi } from '../api-puzzle';
import { useAuth } from '../context/AuthContext';
import type { PuzzleRushLeaderboardEntry } from '@kingside/shared';

type TimeMode = '3' | '5';

export function PuzzleRushLeaderboardPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [timeMode, setTimeMode] = useState<TimeMode>('3');
  const [entries, setEntries] = useState<PuzzleRushLeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    puzzleApi
      .getRushLeaderboard({ timeMode, limit: 50 })
      .then((data) => {
        if (!cancelled) {
          const response = data as { entries: PuzzleRushLeaderboardEntry[] };
          setEntries(response.entries ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(t('rushLeaderboard.error'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [timeMode, t]);

  return (
    <div className="rush-leaderboard-page">
      <h1>{t('rushLeaderboard.title')}</h1>

      <div className="rush-lb-mode-tabs">
        <button
          className={`tc-btn ${timeMode === '3' ? 'active' : ''}`}
          onClick={() => setTimeMode('3')}
        >
          {t('puzzle.rush.threeMinutes')}
        </button>
        <button
          className={`tc-btn ${timeMode === '5' ? 'active' : ''}`}
          onClick={() => setTimeMode('5')}
        >
          {t('puzzle.rush.fiveMinutes')}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="loading">{t('common.loading')}</div>
      ) : entries.length === 0 ? (
        <p className="rush-lb-empty">{t('rushLeaderboard.empty')}</p>
      ) : (
        <div className="rush-lb-table">
          <div className="rush-lb-header-row">
            <span className="rush-lb-col-rank">#</span>
            <span className="rush-lb-col-name">{t('rushLeaderboard.player')}</span>
            <span className="rush-lb-col-score">{t('rushLeaderboard.score')}</span>
          </div>
          {entries.map((entry, index) => {
            const isCurrentUser = user && entry.userId === user.id;
            return (
              <div
                key={`${entry.userId}-${index}`}
                className={`rush-lb-row${isCurrentUser ? ' rush-lb-row-current' : ''}`}
              >
                <span className="rush-lb-col-rank">{index + 1}</span>
                <span className="rush-lb-col-name">{entry.username}</span>
                <span className="rush-lb-col-score">{entry.score}</span>
              </div>
            );
          })}
        </div>
      )}

      <Link to="/puzzle-rush" className="rush-lb-back-link">
        {t('rushLeaderboard.backToRush')}
      </Link>
    </div>
  );
}
