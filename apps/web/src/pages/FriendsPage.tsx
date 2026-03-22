import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useChallenge } from '../hooks/useChallenge';
import { ChallengeModal } from '../components/ChallengeModal';

type FriendItem = {
  friendshipId: string;
  user: { id: string; username: string; ratingBlitz: number };
  online: boolean;
  since: string;
};

type RequestItem = {
  requestId: string;
  user: { id: string; username: string; ratingBlitz: number };
  createdAt: string;
};

export function FriendsPage() {
  const { t } = useTranslation();
  const [friends, setFriends] = useState<FriendItem[]>([]);
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [blocked, setBlocked] = useState<{ id: string; username: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [challengeTarget, setChallengeTarget] = useState<{ id: string; username: string } | null>(null);
  const { state: challengeState, error: challengeError, sendChallenge, cancel: cancelChallenge } = useChallenge();

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [friendsRes, requestsRes, blockedRes] = await Promise.all([
        api.get<{ data: FriendItem[] }>('/api/friends'),
        api.get<{ data: RequestItem[] }>('/api/friends/requests'),
        api.get<{ data: { id: string; username: string }[] }>('/api/users/blocked'),
      ]);
      setFriends(friendsRes.data);
      setRequests(requestsRes.data);
      setBlocked(blockedRes.data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleAccept = useCallback(async (requestId: string) => {
    try {
      await api.post(`/api/friends/accept/${requestId}`, {});
      fetchData();
    } catch { /* ignore */ }
  }, [fetchData]);

  const handleDecline = useCallback(async (requestId: string) => {
    try {
      await api.post(`/api/friends/decline/${requestId}`, {});
      setRequests((prev) => prev.filter((r) => r.requestId !== requestId));
    } catch { /* ignore */ }
  }, []);

  const handleRemove = useCallback(async (friendshipId: string) => {
    try {
      await api.delete(`/api/friends/${friendshipId}`);
      setFriends((prev) => prev.filter((f) => f.friendshipId !== friendshipId));
    } catch { /* ignore */ }
  }, []);

  const handleUnblock = useCallback(async (userId: string) => {
    try {
      await api.delete(`/api/users/unblock/${userId}`);
      setBlocked((prev) => prev.filter((b) => b.id !== userId));
    } catch { /* ignore */ }
  }, []);

  if (loading) {
    return <div className="friends-page"><div className="loading">{t('common.loading')}</div></div>;
  }

  const onlineFriends = friends.filter((f) => f.online);
  const offlineFriends = friends.filter((f) => !f.online);

  return (
    <div className="friends-page">
      <h1>{t('friends.title', 'Friends')}</h1>

      {/* Incoming requests */}
      {requests.length > 0 && (
        <div className="friends-section">
          <h2>{t('friends.requests', 'Friend Requests')} ({requests.length})</h2>
          <div className="friends-list">
            {requests.map((req) => (
              <div key={req.requestId} className="friends-item friends-item--request">
                <div className="friends-item__info">
                  <Link to={`/player/${req.user.username}`} className="friends-item__name">
                    {req.user.username}
                  </Link>
                  <span className="friends-item__rating">{req.user.ratingBlitz}</span>
                </div>
                <div className="friends-item__actions">
                  <button className="friends-btn friends-btn--accept" onClick={() => handleAccept(req.requestId)}>
                    {t('friends.accept', 'Accept')}
                  </button>
                  <button className="friends-btn friends-btn--decline" onClick={() => handleDecline(req.requestId)}>
                    {t('friends.decline', 'Decline')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Online friends */}
      {onlineFriends.length > 0 && (
        <div className="friends-section">
          <h2>{t('friends.online', 'Online')} ({onlineFriends.length})</h2>
          <div className="friends-list">
            {onlineFriends.map((f) => (
              <div key={f.friendshipId} className="friends-item">
                <div className="friends-item__info">
                  <span className="friends-status friends-status--online" />
                  <Link to={`/player/${f.user.username}`} className="friends-item__name">
                    {f.user.username}
                  </Link>
                  <span className="friends-item__rating">{f.user.ratingBlitz}</span>
                </div>
                <div className="friends-item__actions">
                  <button className="friends-btn friends-btn--challenge" onClick={() => setChallengeTarget({ id: f.user.id, username: f.user.username })}>
                    ⚔ {t('challenge.button', 'Challenge')}
                  </button>
                  <button className="friends-btn friends-btn--remove" onClick={() => handleRemove(f.friendshipId)}>
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Offline friends */}
      {offlineFriends.length > 0 && (
        <div className="friends-section">
          <h2>{t('friends.offline', 'Offline')} ({offlineFriends.length})</h2>
          <div className="friends-list">
            {offlineFriends.map((f) => (
              <div key={f.friendshipId} className="friends-item">
                <div className="friends-item__info">
                  <span className="friends-status friends-status--offline" />
                  <Link to={`/player/${f.user.username}`} className="friends-item__name">
                    {f.user.username}
                  </Link>
                  <span className="friends-item__rating">{f.user.ratingBlitz}</span>
                </div>
                <div className="friends-item__actions">
                  <button className="friends-btn friends-btn--remove" onClick={() => handleRemove(f.friendshipId)}>
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Blocked users */}
      {blocked.length > 0 && (
        <div className="friends-section">
          <h2>{t('friends.blocked', 'Blocked')} ({blocked.length})</h2>
          <div className="friends-list">
            {blocked.map((b) => (
              <div key={b.id} className="friends-item friends-item--blocked">
                <div className="friends-item__info">
                  <Link to={`/player/${b.username}`} className="friends-item__name">
                    {b.username}
                  </Link>
                </div>
                <div className="friends-item__actions">
                  <button className="friends-btn friends-btn--accept" onClick={() => handleUnblock(b.id)}>
                    {t('friends.unblock', 'Unblock')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {friends.length === 0 && requests.length === 0 && blocked.length === 0 && (
        <div className="friends-empty">
          <p>{t('friends.empty', 'No friends yet. Visit player profiles to send friend requests.')}</p>
          <Link to="/players" className="friends-link">{t('friends.browsePlayers', 'Browse Players')}</Link>
        </div>
      )}

      {challengeTarget && (
        <ChallengeModal
          targetUsername={challengeTarget.username}
          waiting={challengeState === 'waiting'}
          error={challengeError}
          onSend={(timeInitial, increment) => sendChallenge({ targetUserId: challengeTarget.id, timeInitial, increment })}
          onClose={() => { setChallengeTarget(null); cancelChallenge(); }}
        />
      )}

    </div>
  );
}
