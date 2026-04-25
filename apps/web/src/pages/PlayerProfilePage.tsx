import { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { RatingHistoryChart } from '../components/RatingHistoryChart';
import { AuthorCoursesBlock } from '../components/lessons/AuthorCoursesBlock';
import type { PlayerProfileResponse } from '@kingside/shared';

type FriendStatus = 'none' | 'pending' | 'friends' | 'loading';
type FriendEntry = { friendshipId: string; user: { id: string } };

const RATING_LABELS: Record<string, string> = {
  bullet: '⚡ Bullet',
  blitz: '🔥 Blitz',
  rapid: '⏱ Rapid',
  classical: '♟ Classical',
  puzzle: '🧩 Puzzle',
};

function formatDate(dateStr: string, locale: string): string {
  return new Date(dateStr).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatDateTime(dateStr: string, locale: string): string {
  return new Date(dateStr).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isOnline(lastSeenAt: string): boolean {
  const diff = Date.now() - new Date(lastSeenAt).getTime();
  return diff < 5 * 60 * 1000; // 5 minutes
}

export function PlayerProfilePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();
  const { username } = useParams<{ username: string }>();
  const [profile, setProfile] = useState<PlayerProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');
  const [friendStatus, setFriendStatus] = useState<FriendStatus>('loading');
  const [friendshipId, setFriendshipId] = useState<string | null>(null);
  const [isBlocked, setIsBlocked] = useState(false);

  useEffect(() => {
    if (!username) return;
    setLoading(true);
    setNotFound(false);
    setError('');

    api.get<PlayerProfileResponse>(`/players/${encodeURIComponent(username)}`)
      .then((data) => setProfile(data))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : '';
        if (msg.toLowerCase().includes('not found')) {
          setNotFound(true);
        } else {
          setError(t('playerProfile.loadError'));
        }
      })
      .finally(() => setLoading(false));
  }, [username, t]);

  // Check friendship and block status
  useEffect(() => {
    if (!profile || !currentUser || profile.id === currentUser.id) {
      setFriendStatus('none');
      return;
    }
    setFriendStatus('loading');
    Promise.all([
      api.get<{ data: FriendEntry[] }>('/friends'),
      api.get<{ data: { id: string; username: string }[] }>('/users/blocked'),
      api.get<{ status: string; friendshipId?: string }>(`/friends/status/${profile.id}`)
        .catch(() => ({ status: 'none' as string, friendshipId: undefined as string | undefined })),
    ]).then(([friendsRes, blockedRes, statusRes]) => {
      const entry = friendsRes.data.find((f) => f.user.id === profile.id);
      if (entry) {
        setFriendStatus('friends');
        setFriendshipId(entry.friendshipId);
      } else if (statusRes.status === 'pending') {
        setFriendStatus('pending');
      } else if (statusRes.status === 'accepted' || statusRes.status === 'friends') {
        setFriendStatus('friends');
        if (statusRes.friendshipId) setFriendshipId(statusRes.friendshipId);
      } else {
        setFriendStatus('none');
      }
      setIsBlocked(blockedRes.data.some((b) => b.id === profile.id));
    }).catch(() => setFriendStatus('none'));
  }, [profile, currentUser]);

  const handleAddFriend = useCallback(async () => {
    if (!profile) return;
    setFriendStatus('loading');
    try {
      await api.post(`/friends/request/${profile.id}`, {});
      setFriendStatus('pending');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('already pending') || msg.includes('Already pending')) {
        setFriendStatus('pending');
      } else if (msg.includes('Already friends')) {
        setFriendStatus('friends');
      } else {
        setFriendStatus('none');
      }
    }
  }, [profile]);

  const handleRemoveFriend = useCallback(async () => {
    if (!friendshipId) return;
    setFriendStatus('loading');
    try {
      await api.delete(`/friends/${friendshipId}`);
      setFriendStatus('none');
      setFriendshipId(null);
    } catch {
      setFriendStatus('friends');
    }
  }, [friendshipId]);

  const handleBlock = useCallback(async () => {
    if (!profile) return;
    try {
      await api.post(`/users/block/${profile.id}`, {});
      setIsBlocked(true);
    } catch { /* ignore */ }
  }, [profile]);

  const handleUnblock = useCallback(async () => {
    if (!profile) return;
    try {
      await api.delete(`/users/unblock/${profile.id}`);
      setIsBlocked(false);
    } catch { /* ignore */ }
  }, [profile]);

  if (loading) {
    return (
      <div className="player-profile-page">
        <div className="loading">{t('common.loading')}</div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="player-profile-page">
        <div className="player-profile-not-found">
          <h2>{t('playerProfile.notFound')}</h2>
          <Link to="/players" className="players-link">{t('playerProfile.backToPlayers')}</Link>
        </div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="player-profile-page">
        <div className="error">{error || t('playerProfile.loadError')}</div>
        <Link to="/players" className="players-link">{t('playerProfile.backToPlayers')}</Link>
      </div>
    );
  }

  const online = isOnline(profile.lastSeenAt);
  const { stats } = profile;
  const winRate = stats.totalGames > 0 ? Math.round((stats.wins / stats.totalGames) * 100) : 0;

  return (
    <div className="player-profile-page">
      <Link to="/players" className="player-profile-back">{t('playerProfile.backToPlayers')}</Link>

      {/* Header */}
      <div className="player-profile-header">
        <div className="player-profile-avatar">
          {profile.username[0].toUpperCase()}
        </div>
        <div className="player-profile-info">
          <h1 className="player-profile-username">
            {profile.username}
            <span className={`player-profile-status ${online ? 'online' : 'offline'}`}>
              {online ? t('playerProfile.online') : t('playerProfile.offline')}
            </span>
          </h1>
          <div className="player-profile-meta">
            {t('playerProfile.joined', { date: formatDate(profile.createdAt, i18n.language) })}
            {!online && (
              <span className="player-profile-lastseen">
                {' · '}{t('playerProfile.lastSeen', { date: formatDateTime(profile.lastSeenAt, i18n.language) })}
              </span>
            )}
          <button
            className="player-profile-message-btn"
            onClick={() => navigate(`/messages/${profile.id}`, { state: { username: profile.username } })}
          >
            {t('playerProfile.sendMessage')}
          </button>
          {currentUser && profile.id !== currentUser.id && friendStatus !== 'loading' && (
            <>
              {friendStatus === 'none' && (
                <button className="player-profile-friend-btn" onClick={handleAddFriend}>
                  {t('playerProfile.addFriend', 'Add Friend')}
                </button>
              )}
              {friendStatus === 'pending' && (
                <button className="player-profile-friend-btn player-profile-friend-btn--pending" disabled>
                  {t('playerProfile.requestSent', 'Request Sent')}
                </button>
              )}
              {friendStatus === 'friends' && (
                <button className="player-profile-friend-btn player-profile-friend-btn--remove" onClick={handleRemoveFriend}>
                  {t('playerProfile.removeFriend', 'Remove Friend')}
                </button>
              )}
            </>
          )}
          {currentUser && profile.id !== currentUser.id && (
            isBlocked ? (
              <button className="player-profile-block-btn player-profile-block-btn--unblock" onClick={handleUnblock}>
                {t('playerProfile.unblock', 'Unblock')}
              </button>
            ) : (
              <button className="player-profile-block-btn" onClick={handleBlock}>
                {t('playerProfile.block', 'Block')}
              </button>
            )
          )}
          </div>
        </div>
      </div>

      {/* Ratings */}
      <div className="player-profile-section">
        <h2>{t('playerProfile.ratings')}</h2>
        <div className="player-profile-ratings">
          {(Object.keys(profile.ratings) as Array<keyof typeof profile.ratings>).map((type) => (
            <div key={type} className="player-profile-rating-card">
              <div className="player-profile-rating-label">{RATING_LABELS[type]}</div>
              <div className="player-profile-rating-value">{profile.ratings[type]}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Rating History Chart */}
      <div className="player-profile-section">
        <RatingHistoryChart userId={profile.id} />
      </div>

      {/* KS-1915: публичные курсы автора (если есть). Блок сам
          скрывается при пустом списке / ошибке. */}
      <div className="player-profile-section">
        <AuthorCoursesBlock username={profile.username} />
      </div>

      {/* Puzzle Rush */}
      {profile.puzzleRush && (profile.puzzleRush.best3 > 0 || profile.puzzleRush.best5 > 0) && (
        <div className="player-profile-section">
          <h2>{t('playerProfile.puzzleRush')}</h2>
          <div className="player-profile-ratings">
            <div className="player-profile-rating-card">
              <div className="player-profile-rating-label">{t('playerProfile.best3min')}</div>
              <div className="player-profile-rating-value">{profile.puzzleRush.best3}</div>
            </div>
            <div className="player-profile-rating-card">
              <div className="player-profile-rating-label">{t('playerProfile.best5min')}</div>
              <div className="player-profile-rating-value">{profile.puzzleRush.best5}</div>
            </div>
            <div className="player-profile-rating-card">
              <div className="player-profile-rating-label">{t('playerProfile.totalSessions')}</div>
              <div className="player-profile-rating-value">{profile.puzzleRush.totalSessions}</div>
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="player-profile-section">
        <h2>{t('playerProfile.statistics')}</h2>
        <div className="player-profile-stats">
          <div className="player-profile-stat">
            <span className="player-profile-stat-value">{stats.totalGames}</span>
            <span className="player-profile-stat-label">{t('playerProfile.totalGames')}</span>
          </div>
          <div className="player-profile-stat win">
            <span className="player-profile-stat-value">{stats.wins}</span>
            <span className="player-profile-stat-label">{t('playerProfile.wins')}</span>
          </div>
          <div className="player-profile-stat loss">
            <span className="player-profile-stat-value">{stats.losses}</span>
            <span className="player-profile-stat-label">{t('playerProfile.losses')}</span>
          </div>
          <div className="player-profile-stat draw">
            <span className="player-profile-stat-value">{stats.draws}</span>
            <span className="player-profile-stat-label">{t('playerProfile.draws')}</span>
          </div>
          <div className="player-profile-stat">
            <span className="player-profile-stat-value">{winRate}%</span>
            <span className="player-profile-stat-label">{t('playerProfile.winRate')}</span>
          </div>
        </div>
      </div>

      {/* Recent Games */}
      <div className="player-profile-section">
        <h2>{t('playerProfile.recentGames')}</h2>
        {profile.recentGames.length === 0 ? (
          <div className="player-profile-empty">{t('playerProfile.noGames')}</div>
        ) : (
          <table className="player-profile-games-table">
            <thead>
              <tr>
                <th>{t('playerProfile.opponent')}</th>
                <th>{t('playerProfile.result')}</th>
                <th>{t('playerProfile.timeControl')}</th>
                <th>{t('playerProfile.date')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {profile.recentGames.map((game) => (
                <tr key={game.id}>
                  <td>
                    <Link to={`/player/${game.opponent.username}`} className="players-link">
                      {game.opponent.username}
                    </Link>
                  </td>
                  <td>
                    <span className={`player-profile-game-result ${game.playerResult ?? 'unknown'}`}>
                      {game.playerResult === 'win' && t('playerProfile.resultWin')}
                      {game.playerResult === 'loss' && t('playerProfile.resultLoss')}
                      {game.playerResult === 'draw' && t('playerProfile.resultDraw')}
                      {game.playerResult === null && '—'}
                    </span>
                  </td>
                  <td className="player-profile-tc">
                    {game.timeControl}
                  </td>
                  <td className="player-profile-date">
                    {formatDate(game.createdAt, i18n.language)}
                  </td>
                  <td>
                    <Link to={`/game/${game.id}/review`} className="player-profile-analyze-link">
                      {t('playerProfile.analyze')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
