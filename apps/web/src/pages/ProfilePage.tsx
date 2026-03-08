import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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

type GameRecord = {
  id: string;
  white: { id: string; username: string };
  black: { id: string; username: string };
  result: string;
  timeControl: string;
  createdAt: string;
};

export function ProfilePage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [games, setGames] = useState<GameRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) return;

    const fetchProfile = async () => {
      try {
        const [profileData, gamesData] = await Promise.all([
          api.get<UserProfile>(`/api/users/${user.id}`),
          api.get<GameRecord[]>(`/api/users/${user.id}/games?take=10`),
        ]);
        setProfile(profileData);
        setGames(gamesData);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('profile.error'));
      } finally {
        setLoading(false);
      }
    };

    fetchProfile();
  }, [user]);

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error) return <div className="error">{error}</div>;
  if (!profile) return null;

  const dateLocale = i18n.language === 'ru' ? 'ru-RU' : 'en-US';

  const ratings = [
    { label: t('profile.bullet'), value: profile.ratingBullet },
    { label: t('profile.blitz'), value: profile.ratingBlitz },
    { label: t('profile.rapid'), value: profile.ratingRapid },
    { label: t('profile.classical'), value: profile.ratingClassical },
  ];

  const memberSince = new Date(profile.createdAt).toLocaleDateString(dateLocale, {
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

      {games.length > 0 && (
        <div className="profile-games">
          <h2>{t('profile.recentGames')}</h2>
          <div className="games-list">
            {games.map((game) => {
              const isWhite = game.white.id === profile.id;
              const opponent = isWhite ? game.black.username : game.white.username;
              const date = new Date(game.createdAt).toLocaleDateString(dateLocale);

              return (
                <div key={game.id} className="game-record">
                  <span className="game-opponent">{t('profile.vs', { opponent })}</span>
                  <span className="game-tc">{game.timeControl}</span>
                  <span className="game-result-badge">{game.result}</span>
                  <span className="game-date">{date}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
