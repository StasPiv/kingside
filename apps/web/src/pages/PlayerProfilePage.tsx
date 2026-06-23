import { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useRequireAuth } from '../context/RequireAuthContext';
import { RatingHistoryChart } from '../components/RatingHistoryChart';
import { AuthorCoursesBlock } from '../components/lessons/AuthorCoursesBlock';
// KS-2236 (ADR-035 §7, E3): drill-статистика на собственном профиле.
import { DrillStatsPanel } from '../components/drills';
// KS-4363 (ADR-136 T11): секция «Точность» на собственном профиле.
import { TacticPuzzleProfilePanel } from '../components/tactic-puzzles/TacticPuzzleProfilePanel';
// KS-3738 (ADR-110 §8): секция «Мои live-трансляции» на собственном профиле.
import { useFeatureFlag } from '../context/FeatureFlagsContext';
import type { PlayerProfileResponse } from '@kingside/shared';
import { SeoHelmet } from '../components/seo/SeoHelmet';

/**
 * KS-2169 (F3): расширение `PlayerProfileResponse` опциональными полями,
 * которые backend KS-2160/2167 может отдавать дополнительно. Используется
 * только для type-narrowing: если поле отсутствует — UI не рендерит его.
 *
 * Намеренно НЕ правим shared-тип отсюда (он RW только у backend), чтобы
 * не блокировать релиз фронта на консенсус по типу. Когда backend
 * официально внесёт поля в `PlayerProfileResponse`, этот local extend
 * можно будет удалить.
 */
type PlayerProfileExtended = PlayerProfileResponse & {
  country?: string | null;
  gamesToday?: number;
};

/**
 * KS-2169: country code (ISO-2) → emoji flag. ISO-3166 alpha-2 коды
 * мапятся на regional indicator unicode block (U+1F1E6 + offset).
 */
function countryFlag(code: string | null | undefined): string | null {
  if (!code || code.length !== 2) return null;
  const A = 0x41;
  const REGIONAL = 0x1f1e6;
  const cc = code.toUpperCase();
  const c0 = cc.charCodeAt(0);
  const c1 = cc.charCodeAt(1);
  if (c0 < A || c0 > A + 25 || c1 < A || c1 > A + 25) return null;
  return String.fromCodePoint(REGIONAL + (c0 - A)) + String.fromCodePoint(REGIONAL + (c1 - A));
}

type FriendStatus = 'none' | 'pending' | 'friends' | 'loading';
type FriendEntry = { friendshipId: string; user: { id: string } };

/**
 * KS-4559: подписи рейтинговых карточек локализованы. Возвращаем
 * map типа рейтинга → подпись на текущей локали. Эмодзи остаются
 * в значениях ключей (см. `playerProfile.rating.*` в локалях),
 * чтобы переводчики могли при необходимости менять и порядок «эмодзи
 * + текст», и сам набор эмодзи. Дефолты — английские значения.
 */
function useRatingLabels(): Record<string, string> {
  const { t } = useTranslation();
  return {
    bullet: t('playerProfile.rating.bullet', '⚡ Bullet'),
    blitz: t('playerProfile.rating.blitz', '🔥 Blitz'),
    rapid: t('playerProfile.rating.rapid', '⏱ Rapid'),
    classical: t('playerProfile.rating.classical', '♟ Classical'),
    puzzle: t('playerProfile.rating.puzzle', '🧩 Puzzle'),
  };
}

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
  const requireAuth = useRequireAuth();
  const { username } = useParams<{ username: string }>();
  const [profile, setProfile] = useState<PlayerProfileExtended | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');
  const [friendStatus, setFriendStatus] = useState<FriendStatus>('loading');
  const [friendshipId, setFriendshipId] = useState<string | null>(null);
  const [isBlocked, setIsBlocked] = useState(false);
  // KS-2236: drill-статистика только на собственном профиле и
  // только при включённом drillsEnabled (KS-2231).
  const drillsEnabled = useFeatureFlag('drillsEnabled');
  // KS-4559: подписи рейтинговых карточек локализованы.
  const ratingLabels = useRatingLabels();

  useEffect(() => {
    if (!username) return;
    setLoading(true);
    setNotFound(false);
    setError('');

    api.get<PlayerProfileExtended>(`/players/${encodeURIComponent(username)}`)
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

  // KS-4185 / ADR-128 §7.6.1.2 P2. Profile-level SEO. `bestType`/
  // `bestRating` — максимум по 4 контролям (puzzle не считаем как
  // «лучший шахматный контроль»). JSON-LD type=Person.
  const ratingPairs: { type: string; rating: number }[] = [
    { type: 'bullet', rating: profile.ratingBullet },
    { type: 'blitz', rating: profile.ratingBlitz },
    { type: 'rapid', rating: profile.ratingRapid },
    { type: 'classical', rating: profile.ratingClassical },
  ];
  const best = ratingPairs.reduce((a, b) => (b.rating > a.rating ? b : a));
  const seoTitle = t('seo.players.profile.title', {
    username: profile.username,
    bestRating: best.rating,
    bestType: best.type,
  });
  const seoDescription = t('seo.players.profile.description', {
    username: profile.username,
    bullet: profile.ratingBullet,
    blitz: profile.ratingBlitz,
    rapid: profile.ratingRapid,
    classical: profile.ratingClassical,
    totalGames: stats.totalGames,
  });
  const seoCanonical = `https://kingside.site/player/${encodeURIComponent(profile.username)}`;
  const seoJsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: profile.username,
    alternateName: profile.username,
    description: seoDescription,
    nationality: profile.country ?? undefined,
    url: seoCanonical,
  };

  return (
    <div className="player-profile-page">
      <SeoHelmet
        title={seoTitle}
        description={seoDescription}
        canonical={seoCanonical}
        ogType="profile"
        ogImage="/og/player.png"
        jsonLd={seoJsonLd}
      />
      <Link to="/players" className="player-profile-back">{t('playerProfile.backToPlayers')}</Link>

      {/* Header */}
      <div className="player-profile-header">
        <div className="player-profile-avatar">
          {profile.username[0].toUpperCase()}
        </div>
        <div className="player-profile-info">
          <h1 className="player-profile-username">
            {/* KS-2169 (F3): флаг страны (если backend отдал country).
                Никаких визуальных меток «AI» / «Synthetic» / «Bot» —
                disclosure = soft, профиль synthetic визуально неотличим
                от живого. */}
            {(() => {
              const flag = countryFlag(profile.country ?? null);
              return flag ? (
                <span className="player-profile-flag" title={profile.country ?? undefined} style={{ marginRight: 6 }}>{flag}</span>
              ) : null;
            })()}
            {profile.username}
            <span className={`player-profile-status ${online ? 'online' : 'offline'}`}>
              {online ? t('playerProfile.online') : t('playerProfile.offline')}
            </span>
            {/* KS-3788 / ADR-113 §1: бейдж «Тренер». Виден только если
                backend выставил `isCoach=true` (есть хотя бы один
                публичный курс или лекция). Сам бейдж — ссылка на
                публичную витрину тренера /coach/:username. */}
            {profile.isCoach && (
              <Link
                to={`/coach/${encodeURIComponent(profile.username)}`}
                className="player-profile-coach-badge"
                data-testid="player-profile-coach-badge"
                style={{
                  marginLeft: 12,
                  padding: '2px 10px',
                  borderRadius: 12,
                  background: '#1976d2',
                  color: '#fff',
                  fontSize: 14,
                  textDecoration: 'none',
                  verticalAlign: 'middle',
                }}
                title={t('coachProfile.openCoachPage', 'Open coach page')}
              >
                {t('coachProfile.badge', 'Coach')}
              </Link>
            )}
          </h1>
          <div className="player-profile-meta">
            {t('playerProfile.joined', { date: formatDate(profile.createdAt, i18n.language) })}
            {!online && (
              <span className="player-profile-lastseen">
                {' · '}{t('playerProfile.lastSeen', { date: formatDateTime(profile.lastSeenAt, i18n.language) })}
              </span>
            )}
            {/* KS-2169 (F3): gamesToday — если backend отдаёт. */}
            {typeof profile.gamesToday === 'number' && profile.gamesToday >= 0 && (
              <span className="player-profile-games-today" style={{ marginLeft: 8 }}>
                {' · '}
                {t('playerProfile.gamesToday', { count: profile.gamesToday, defaultValue: 'played today: {{count}}' })}
              </span>
            )}
          {/* KS-4560: «Написать сообщение» — только для чужих профилей.
              Раньше кнопка отображалась всегда и на собственном профиле
              открывала диалог с самим собой. Гостю (currentUser=null)
              кнопка по-прежнему показывается — клик ведёт в
              LoginRequiredModal через requireAuth. */}
          {(!currentUser || profile.id !== currentUser.id) && (
            <button
              className="player-profile-message-btn"
              onClick={() => {
                // KS-4124 / ADR-128 §6: гостю показываем
                // LoginRequiredModal с описанием действия. Авторизованному
                // — выполняем переход в /messages сразу. returnUrl
                // сохраняет requireAuth сам (текущий path+search).
                requireAuth(
                  () =>
                    navigate(`/messages/${profile.id}`, {
                      state: { username: profile.username },
                    }),
                  {
                    description: t(
                      'auth.loginRequired.sendMessage',
                      'Sign in to message {{username}} on Kingside.',
                      { username: profile.username },
                    ),
                  },
                );
              }}
            >
              {t('playerProfile.sendMessage')}
            </button>
          )}
          {/* ADR-067 (KS-3131): ссылка «Студии этого пользователя»
              удалена вместе с модулем Studies. */}
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
              <div className="player-profile-rating-label">{ratingLabels[type]}</div>
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

      {/* KS-2236: drill-статистика — только владельцу профиля и
          только при включённом флаге `drillsEnabled`. На чужом профиле
          panel НЕ рендерится — endpoint `/stats/me` доступен только
          авторизованному пользователю и вернул бы 401. */}
      {drillsEnabled && currentUser && currentUser.id === profile.id && (
        <div className="player-profile-section">
          <DrillStatsPanel />
        </div>
      )}

      {/* KS-4363 (ADR-136 T11): секция «Точность». Только владельцу
          профиля — `/tactic-puzzles/stats/me` доступен только
          авторизованному пользователю. Публичной выдачи рейтинга по
          username пока нет — добавление эндпоинта отдельной задачей. */}
      {currentUser && currentUser.id === profile.id && (
        <TacticPuzzleProfilePanel />
      )}

      {/* KS-3781: секция «Мои live-трансляции» убрана из профиля —
          её вернёт отдельная задача, когда появится полноценная
          история сохранённых трансляций. Компонент удалён вместе
          с импортом, чтобы не зависал мёртвым кодом в bundle. */}

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
