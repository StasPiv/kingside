import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { useActiveGame } from '../hooks/useActiveGame';

type TournamentSummary = {
  id: string;
  name: string;
  type: string;
  status: string;
  _count?: { entries: number };
};

const TC_PRESETS = [
  { label: '1+0', time: 60, inc: 0, type: 'Bullet' },
  { label: '3+0', time: 180, inc: 0, type: 'Blitz' },
  { label: '3+2', time: 180, inc: 2, type: 'Blitz' },
  { label: '5+0', time: 300, inc: 0, type: 'Blitz' },
  { label: '5+3', time: 300, inc: 3, type: 'Blitz' },
  { label: '10+0', time: 600, inc: 0, type: 'Rapid' },
  { label: '15+10', time: 900, inc: 10, type: 'Rapid' },
];

export function DashboardPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { activeGame } = useActiveGame(!!user);
  const [tournaments, setTournaments] = useState<TournamentSummary[]>([]);

  useEffect(() => {
    api.get<TournamentSummary[]>('/api/arena')
      .then((data) => setTournaments(data.filter((t) => t.status === 'active' || t.status === 'upcoming').slice(0, 5)))
      .catch(() => {});
  }, []);

  return (
    <div className="dashboard-page">
      <div className="dashboard-grid">
        {/* LEFT: Play */}
        <div className="dashboard-col">
          <div className="dashboard-card">
            <h2>{t('dashboard.play', 'Play')}</h2>

            {activeGame && (
              <Link to={`/game/${activeGame.gameId}`} className="dashboard-active-game">
                {t('nav.backToGame', 'Back to game')} vs {activeGame.opponent}
              </Link>
            )}

            <div className="dashboard-tc-grid">
              {TC_PRESETS.map((tc) => (
                <Link
                  key={tc.label}
                  to={`/lobby?time=${tc.time}&inc=${tc.inc}`}
                  className="dashboard-tc-btn"
                >
                  <span className="dashboard-tc-label">{tc.label}</span>
                  <span className="dashboard-tc-type">{tc.type}</span>
                </Link>
              ))}
            </div>

            <div className="dashboard-play-links">
              <Link to="/lobby" className="dashboard-link">{t('dashboard.customGame', 'Custom Game')}</Link>
              <Link to="/games/live" className="dashboard-link">{t('dashboard.liveGames', 'Live Games')}</Link>
            </div>
          </div>

          <div className="dashboard-card">
            <h2>{t('dashboard.puzzles', 'Puzzles')}</h2>
            <div className="dashboard-puzzle-links">
              <Link to="/daily" className="dashboard-link">{t('nav.dailyPuzzle', 'Daily Puzzle')}</Link>
              <Link to="/puzzle-rush" className="dashboard-link">{t('nav.puzzleRush', 'Puzzle Rush')}</Link>
              <Link to="/puzzles" className="dashboard-link">{t('nav.myPuzzles', 'My Puzzles')}</Link>
            </div>
          </div>
        </div>

        {/* RIGHT: Activity */}
        <div className="dashboard-col">
          <div className="dashboard-card">
            <h2>{t('dashboard.tournaments', 'Tournaments')}</h2>
            {tournaments.length === 0 ? (
              <p className="dashboard-empty">{t('tournaments.empty', 'No tournaments')}</p>
            ) : (
              <div className="dashboard-tournament-list">
                {tournaments.map((t) => (
                  <Link key={t.id} to={`/tournaments/${t.id}`} className="dashboard-tournament-item">
                    <span className="dashboard-tournament-name">{t.name}</span>
                    <span className={`dashboard-tournament-status dashboard-tournament-status--${t.status}`}>
                      {t.status}
                    </span>
                  </Link>
                ))}
              </div>
            )}
            <Link to="/tournaments" className="dashboard-link dashboard-link--all">
              {t('dashboard.allTournaments', 'All Tournaments')} &rarr;
            </Link>
          </div>

          <div className="dashboard-card">
            <h2>{t('dashboard.ratings', 'My Ratings')}</h2>
            {user && (
              <div className="dashboard-ratings">
                {[
                  { label: 'Bullet', value: user.ratingBullet },
                  { label: 'Blitz', value: user.ratingBlitz },
                  { label: 'Rapid', value: user.ratingRapid },
                  { label: 'Puzzle', value: user.ratingPuzzle },
                ].map((r) => (
                  <div key={r.label} className="dashboard-rating-item">
                    <span className="dashboard-rating-label">{r.label}</span>
                    <span className="dashboard-rating-value">{r.value ?? '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="dashboard-card">
            <h2>{t('dashboard.workshop', 'Workshop')}</h2>
            <div className="dashboard-workshop-links">
              <Link to="/workshop" className="dashboard-link">{t('nav.analyses', 'Analyses')}</Link>
              <Link to="/analysis" className="dashboard-link">{t('nav.newAnalysis', 'New Analysis')}</Link>
              <Link to="/workshop/pgn-files" className="dashboard-link">{t('nav.pgnFiles', 'PGN Files')}</Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
