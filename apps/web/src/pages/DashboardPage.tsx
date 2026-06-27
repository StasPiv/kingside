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
    api.get<TournamentSummary[]>('/arena')
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

            <div className="dashboard-action-cards">
              <Link to="/lobby" className="dash-action-card">
                <span className="dash-action-icon">&#9881;</span>
                <div className="dash-action-text">
                  <span className="dash-action-title">{t('dashboard.customGame', 'Custom Game')}</span>
                  <span className="dash-action-desc">{t('dashboard.customGameDesc', 'Set your own time control')}</span>
                </div>
              </Link>
              <Link to="/games/live" className="dash-action-card">
                <span className="dash-action-icon">&#9654;</span>
                <div className="dash-action-text">
                  <span className="dash-action-title">{t('dashboard.liveGames', 'Live Games')}</span>
                  <span className="dash-action-desc">{t('dashboard.liveGamesDesc', 'Watch games in progress')}</span>
                </div>
              </Link>
            </div>
          </div>

          <div className="dashboard-card">
            <h2>{t('dashboard.puzzles', 'Puzzles')}</h2>
            <div className="dashboard-action-cards">
              <Link to="/puzzle-rush" className="dash-action-card">
                <span className="dash-action-icon">&#9889;</span>
                <div className="dash-action-text">
                  <span className="dash-action-title">{t('nav.puzzleRush', 'Puzzle Rush')}</span>
                  <span className="dash-action-desc">{t('dashboard.rushDesc', 'Solve as many as you can')}</span>
                </div>
              </Link>
              <Link
                to="/puzzles"
                className="dash-action-card"
                /* KS-4704 / ADR-147 §9: anchor `puzzles-comeback`
                   (`home-puzzles-tile`). */
                data-hint-anchor="home-puzzles-tile"
              >
                <span className="dash-action-icon">&#9819;</span>
                <div className="dash-action-text">
                  <span className="dash-action-title">{t('nav.myPuzzles', 'My Puzzles')}</span>
                  <span className="dash-action-desc">{t('dashboard.myPuzzlesDesc', 'Browse your collection')}</span>
                </div>
              </Link>
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
            <Link to="/tournaments" className="dash-action-card dash-action-card--compact">
              <span className="dash-action-icon">&#9813;</span>
              <span className="dash-action-title">{t('dashboard.allTournaments', 'All Tournaments')}</span>
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
            <div className="dashboard-action-cards">
              <Link to="/workshop" className="dash-action-card">
                <span className="dash-action-icon">&#128269;</span>
                <div className="dash-action-text">
                  <span className="dash-action-title">{t('nav.analyses', 'Analyses')}</span>
                  <span className="dash-action-desc">{t('dashboard.analysesDesc', 'Review your games')}</span>
                </div>
              </Link>
              <Link to="/analysis" className="dash-action-card">
                <span className="dash-action-icon">&#10010;</span>
                <div className="dash-action-text">
                  <span className="dash-action-title">{t('nav.newAnalysis', 'New Analysis')}</span>
                  <span className="dash-action-desc">{t('dashboard.newAnalysisDesc', 'Analyze a position')}</span>
                </div>
              </Link>
              <Link to="/workshop/pgn-files" className="dash-action-card">
                <span className="dash-action-icon">&#128196;</span>
                <div className="dash-action-text">
                  <span className="dash-action-title">{t('nav.pgnFiles', 'PGN Files')}</span>
                  <span className="dash-action-desc">{t('dashboard.pgnDesc', 'Upload and browse PGN')}</span>
                </div>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
