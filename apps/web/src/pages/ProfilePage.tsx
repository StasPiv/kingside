import { useState, useEffect, useRef, useCallback } from 'react';
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
  playerColor: 'white' | 'black';
  playerResult: 'win' | 'loss' | 'draw';
  opponent: { id: string; username: string; ratingBefore: number | null };
  ecoCode: string | null;
  openingName: string | null;
  result: string;
  termination: string | null;
  timeControlType: string | null;
  timeControl: string;
  totalMoves: number;
  createdAt: string;
  finishedAt: string | null;
  whiteRatingBefore: number | null;
  whiteRatingAfter: number | null;
  blackRatingBefore: number | null;
  blackRatingAfter: number | null;
};

type GamesResponse = {
  data: GameRecord[];
  total: number;
  hasMore: boolean;
};

type Filters = {
  opponent: string;
  result: '' | 'win' | 'loss' | 'draw';
  color: '' | 'white' | 'black';
  eco: string;
};

const PAGE_SIZE = 20;

export function ProfilePage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [games, setGames] = useState<GameRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [rushStats, setRushStats] = useState<PuzzleRushStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState<Filters>({ opponent: '', result: '', color: '', eco: '' });
  const sentinelRef = useRef<HTMLDivElement>(null);
  const skipRef = useRef(0);

  const buildQuery = useCallback((f: Filters, skip: number) => {
    const params = new URLSearchParams();
    params.set('take', String(PAGE_SIZE));
    params.set('skip', String(skip));
    if (f.opponent) params.set('opponent', f.opponent);
    if (f.result) params.set('result', f.result);
    if (f.color) params.set('color', f.color);
    if (f.eco) params.set('eco', f.eco);
    return params.toString();
  }, []);

  useEffect(() => {
    if (!user) return;

    const fetchProfile = async () => {
      try {
        const query = buildQuery(filters, 0);
        const [profileData, gamesData, rushData] = await Promise.all([
          api.get<UserProfile>(`/api/users/${user.id}`),
          api.get<GamesResponse>(`/api/users/${user.id}/games?${query}`),
          api.get<PuzzleRushStats>(`/api/users/${user.id}/puzzle-rush-stats`),
        ]);
        setProfile(profileData);
        setGames(gamesData.data);
        setHasMore(gamesData.hasMore);
        skipRef.current = gamesData.data.length;
        setRushStats(rushData);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('profile.loadError'));
      } finally {
        setLoading(false);
      }
    };

    fetchProfile();
  }, [user]);

  // Reload games when filters change
  useEffect(() => {
    if (!user || !profile) return;

    const fetchFiltered = async () => {
      try {
        const query = buildQuery(filters, 0);
        const gamesData = await api.get<GamesResponse>(`/api/users/${user.id}/games?${query}`);
        setGames(gamesData.data);
        setHasMore(gamesData.hasMore);
        skipRef.current = gamesData.data.length;
      } catch {
        // keep existing games on filter error
      }
    };

    fetchFiltered();
  }, [filters, user, profile, buildQuery]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    if (!hasMore || !user || !profile) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore) {
          setLoadingMore(true);
          const query = buildQuery(filters, skipRef.current);
          api.get<GamesResponse>(`/api/users/${user.id}/games?${query}`)
            .then((res) => {
              setGames((prev) => [...prev, ...res.data]);
              setHasMore(res.hasMore);
              skipRef.current += res.data.length;
            })
            .catch(() => {})
            .finally(() => setLoadingMore(false));
        }
      },
      { threshold: 0.1 },
    );

    const el = sentinelRef.current;
    if (el) observer.observe(el);
    return () => { if (el) observer.unobserve(el); };
  }, [hasMore, loadingMore, filters, user, profile, buildQuery]);

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

  const handleFilterChange = (key: keyof Filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="profile-page">
      <div className="profile-layout">
        <aside className="profile-sidebar">
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
                <Link to="/puzzle-rush" className="profile-action-btn profile-action-btn--green">{t('profile.playPuzzleRush')}</Link>
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
        </aside>

        <main className="profile-main">
          <div className="profile-games">
            <div className="profile-section-header">
              <h2>{t('profile.recentGames')}</h2>
              <Link to="/lobby" className="profile-action-btn">{t('profile.play')}</Link>
            </div>

            <div className="games-filters">
              <input
                type="text"
                className="games-filter-input"
                placeholder={t('profile.filterOpponent')}
                value={filters.opponent}
                onChange={(e) => handleFilterChange('opponent', e.target.value)}
              />
              <select
                className="games-filter-select"
                value={filters.result}
                onChange={(e) => handleFilterChange('result', e.target.value)}
              >
                <option value="">{t('profile.filterResultAll')}</option>
                <option value="win">{t('profile.filterResultWin')}</option>
                <option value="loss">{t('profile.filterResultLoss')}</option>
                <option value="draw">{t('profile.filterResultDraw')}</option>
              </select>
              <select
                className="games-filter-select"
                value={filters.color}
                onChange={(e) => handleFilterChange('color', e.target.value)}
              >
                <option value="">{t('profile.filterColorAll')}</option>
                <option value="white">{t('profile.filterColorWhite')}</option>
                <option value="black">{t('profile.filterColorBlack')}</option>
              </select>
              <input
                type="text"
                className="games-filter-input games-filter-eco"
                placeholder={t('profile.filterEco')}
                value={filters.eco}
                onChange={(e) => handleFilterChange('eco', e.target.value)}
              />
            </div>

            <div className="games-list">
              {games.map((game) => {
                const isWhite = game.playerColor === 'white';
                const ratingBefore = isWhite ? game.whiteRatingBefore : game.blackRatingBefore;
                const ratingAfter = isWhite ? game.whiteRatingAfter : game.blackRatingAfter;
                const ratingDiff = ratingBefore != null && ratingAfter != null ? ratingAfter - ratingBefore : null;
                const date = new Date(game.createdAt).toLocaleDateString(locale);
                const durationMs = game.finishedAt
                  ? new Date(game.finishedAt).getTime() - new Date(game.createdAt).getTime()
                  : null;
                const duration = durationMs != null
                  ? `${Math.floor(durationMs / 60000)}:${Math.floor((durationMs % 60000) / 1000).toString().padStart(2, '0')}`
                  : '—';
                const resultKey = game.playerResult === 'win'
                  ? 'profile.resultWin'
                  : game.playerResult === 'loss'
                    ? 'profile.resultLoss'
                    : 'profile.resultDraw';

                return (
                  <Link key={game.id} to={`/game/${game.id}/review`} className="game-record game-record-link">
                    <span className={`game-result-badge game-result-badge--${game.playerResult}`}>
                      {t(resultKey)}
                    </span>
                    <span className={`game-color-indicator ${isWhite ? 'color-white' : 'color-black'}`} />
                    <span className="game-opponent">
                      {t('profile.vs', { opponent: game.opponent.username })}
                      {game.opponent.ratingBefore != null && (
                        <span className="game-opponent-rating"> ({game.opponent.ratingBefore})</span>
                      )}
                    </span>
                    <span className="game-opening">
                      {game.ecoCode && <span className="game-eco">{game.ecoCode}</span>}
                      {game.openingName && <span className="game-opening-name">{game.openingName}</span>}
                    </span>
                    <span className="game-tc">{game.timeControlType || game.timeControl}</span>
                    <span className="game-moves-count">{game.totalMoves}</span>
                    <span className="game-duration">{duration}</span>
                    <span className={`game-rating-diff ${ratingDiff != null && ratingDiff >= 0 ? 'rating-positive' : 'rating-negative'}`}>
                      {ratingDiff != null ? (ratingDiff >= 0 ? `+${ratingDiff}` : ratingDiff) : '—'}
                    </span>
                    <span className="game-date">{date}</span>
                  </Link>
                );
              })}
              {games.length === 0 && (
                <div className="games-empty">{t('profile.noGames')}</div>
              )}
            </div>
            {hasMore && (
              <div ref={sentinelRef} className="games-load-more">
                {loadingMore && <span>{t('common.loading')}</span>}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
