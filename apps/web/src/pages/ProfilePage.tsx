import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';

type UserProfile = {
  id: string;
  username: string;
  ratingBullet: number;
  ratingBlitz: number;
  ratingRapid: number;
  ratingClassical: number;
  createdAt: string;
  lastSeenAt: string;
};

type PuzzleRushStats = {
  best3: number;
  best5: number;
  totalSessions: number;
};

type GameRecord = {
  id: string;
  white: { id: string; username: string };
  black: { id: string; username: string };
  result: string;
  timeControl: string;
  createdAt: string;
  whiteRatingBefore: number | null;
  whiteRatingAfter: number | null;
  blackRatingBefore: number | null;
  blackRatingAfter: number | null;
};

export function ProfilePage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [games, setGames] = useState<GameRecord[]>([]);
  const [rushStats, setRushStats] = useState<PuzzleRushStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) return;

    const fetchProfile = async () => {
      try {
        const [profileData, gamesData, rushData] = await Promise.all([
          api.get<UserProfile>(`/api/users/${user.id}`),
          api.get<GameRecord[]>(`/api/users/${user.id}/games?take=10`),
          api.get<PuzzleRushStats>(`/api/users/${user.id}/puzzle-rush-stats`),
        ]);
        setProfile(profileData);
        setGames(gamesData);
        setRushStats(rushData);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('profile.loadError'));
      } finally {
        setLoading(false);
      }
    };

    fetchProfile();
  }, [user]);

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error) return <div className="error">{error}</div>;
  if (!profile) return null;

  const locale = i18n.language === 'ru' ? 'ru-RU' : 'en-US';

  const ratings = [
    { label: t('profile.bullet'), value: profile.ratingBullet },
    { label: t('profile.blitz'), value: profile.ratingBlitz },
    { label: t('profile.rapid'), value: profile.ratingRapid },
    { label: t('profile.classical'), value: profile.ratingClassical },
  ];

  const memberSince = new Date(profile.createdAt).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="profile-page">
      <div className="profile-header">
        <h1>{profile.username}</h1>
        <p className="profile-member-since">{t('profile.memberSince', { date: memberSince })}</p>
      </div>

      <div className="profile-ratings">
        <h2>{t('profile.ratings')}</h2>
        <div className="ratings-grid">
          {ratings.map((r) => (
            <div key={r.label} className="rating-card">
              <span className="rating-label">{r.label}</span>
              <span className="rating-value">{r.value}</span>
            </div>
          ))}
        </div>
      </div>

      {rushStats && (rushStats.best3 > 0 || rushStats.best5 > 0 || rushStats.totalSessions > 0) && (
        <div className="profile-puzzle-rush">
          <div className="profile-section-header">
            <h2>{t('profile.puzzleRush')}</h2>
            <Link to="/puzzle-rush" className="profile-section-link">{t('profile.playPuzzleRush')}</Link>
          </div>
          <div className="rush-stats-grid">
            <div className="rush-stat-card">
              <span className="rush-stat-label">{t('profile.rushBest3')}</span>
              <span className="rush-stat-value">{rushStats.best3}</span>
            </div>
            <div className="rush-stat-card">
              <span className="rush-stat-label">{t('profile.rushBest5')}</span>
              <span className="rush-stat-value">{rushStats.best5}</span>
            </div>
            <div className="rush-stat-card">
              <span className="rush-stat-label">{t('profile.rushTotalSessions')}</span>
              <span className="rush-stat-value">{rushStats.totalSessions}</span>
            </div>
          </div>
        </div>
      )}

      {games.length > 0 && (
        <div className="profile-games">
          <div className="profile-section-header">
            <h2>{t('profile.recentGames')}</h2>
            <Link to="/lobby" className="profile-section-link">{t('profile.play')}</Link>
          </div>
          <div className="games-list">
            {games.map((game) => {
              const isWhite = game.white.id === profile.id;
              const opponent = isWhite ? game.black.username : game.white.username;
              const date = new Date(game.createdAt).toLocaleDateString(locale);
              const ratingBefore = isWhite ? game.whiteRatingBefore : game.blackRatingBefore;
              const ratingAfter = isWhite ? game.whiteRatingAfter : game.blackRatingAfter;
              const ratingDiff = ratingBefore != null && ratingAfter != null ? ratingAfter - ratingBefore : null;

              return (
                <Link key={game.id} to={`/game/${game.id}/review`} className="game-record game-record-link">
                  <span className="game-opponent">{t('profile.vs', { opponent })}</span>
                  <span className="game-tc">{game.timeControl}</span>
                  <span className="game-result-badge">{game.result}</span>
                  {ratingDiff != null && (
                    <span className={`game-rating-diff ${ratingDiff >= 0 ? 'rating-positive' : 'rating-negative'}`}>
                      {ratingDiff >= 0 ? `+${ratingDiff}` : ratingDiff}
                    </span>
                  )}
                  <span className="game-date">{date}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
