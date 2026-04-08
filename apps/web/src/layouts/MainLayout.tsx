import { useState, useRef, useEffect, useCallback } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FcGoogle } from 'react-icons/fc';
import { FaFacebook, FaTelegram, FaCode, FaEnvelope, FaBell, FaUserFriends } from 'react-icons/fa';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { useChallenge } from '../hooks/useChallenge';
import { useNotifications } from '../hooks/useNotifications';
import { useActiveGame } from '../hooks/useActiveGame';
import { IncomingChallengeToast } from '../components/IncomingChallengeToast';
import { NotificationDropdown } from '../components/NotificationDropdown';
import { MobileBottomBar } from '../components/MobileBottomBar';
import { Sidebar } from '../components/Sidebar';
import { redirectToTelegramOAuth } from '../utils/telegramOAuth';

const DEV_BYPASS_SECRET = import.meta.env.VITE_DEV_BYPASS_SECRET;
const isLocalhost = window.location.hostname === 'localhost';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

function useClickOutside(ref: React.RefObject<HTMLElement | null>, handler: () => void) {
  useEffect(() => {
    const listener = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      handler();
    };
    document.addEventListener('mousedown', listener);
    return () => document.removeEventListener('mousedown', listener);
  }, [ref, handler]);
}

export function MainLayout() {
  const { user, logout } = useAuth();
  const { t, i18n } = useTranslation();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const { incoming, acceptChallenge, declineChallenge } = useChallenge();
  const [notifOpen, setNotifOpen] = useState(false);
  const {
    notifications,
    unreadCount: notifUnreadCount,
    loading: notifLoading,
    fetchNotifications,
    markAsRead,
    markAllAsRead,
  } = useNotifications(!!user);
  const { activeGame } = useActiveGame(!!user);

  const handleNotifToggle = useCallback(() => {
    setNotifOpen((prev) => {
      if (!prev) fetchNotifications();
      return !prev;
    });
  }, [fetchNotifications]);

  const handleNotifClose = useCallback(() => setNotifOpen(false), []);

  const userMenuRef = useRef<HTMLDivElement>(null);

  useClickOutside(userMenuRef, () => setUserMenuOpen(false));

  // Poll unread message count via REST (no WS dependency)
  useEffect(() => {
    if (!user) { setUnreadCount(0); return; }
    const fetchUnread = () => {
      api.get<{ count: number }>('/api/messages/unread-count')
        .then((data) => setUnreadCount(data.count))
        .catch(() => {});
    };
    fetchUnread();
    const interval = setInterval(fetchUnread, 15_000);

    const onMessagesRead = () => fetchUnread();
    window.addEventListener('messages:read', onMessagesRead);

    return () => {
      clearInterval(interval);
      window.removeEventListener('messages:read', onMessagesRead);
    };
  }, [user]);

  // Online players count
  const [onlineCount, setOnlineCount] = useState<number | null>(null);

  useEffect(() => {
    const fetchCount = () => {
      fetch(`${API_URL}/api/players/online?limit=1`)
        .then((r) => r.ok ? r.json() : null)
        .then((data: { total?: number } | null) => {
          if (data?.total != null) setOnlineCount(data.total);
        })
        .catch(() => {});
    };
    fetchCount();
    const interval = setInterval(fetchCount, 30_000);
    return () => clearInterval(interval);
  }, []);

  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    fetch('/version.json')
      .then((r) => r.json())
      .then((data: { version: string }) => {
        setAppVersion(data.version);
        document.title = `Kingside (v.${data.version})`;
      })
      .catch(() => {});
  }, []);

  const location = useLocation();

  const closeAll = () => {
    setUserMenuOpen(false);
  };

  // Hide mobile bottom bar during active game (sidebar always visible)
  const hideBottomBar = location.pathname.startsWith('/game/');

  return (
    <div className="app">
      <header className="header">
        <nav className="header-nav">
          {/* LEFT: Logo */}
          <div className="header-left">
            <Link to="/" className="logo" onClick={closeAll} title={appVersion ? `v.${appVersion}` : undefined}>
              Kingside
            </Link>
          </div>

          {/* RIGHT: Utilities + Profile */}
          <div className="header-right">
            {activeGame && (
              <Link to={`/game/${activeGame.gameId}`} className="active-game-btn">
                {t('nav.backToGame', 'Back to game')}
              </Link>
            )}
            {/* Bell + Messages: always visible (even mobile) */}
            {user && (
              <div className="nav-notification-wrapper">
                <button
                  className="header-icon-btn"
                  onClick={handleNotifToggle}
                  title={t('notifications.title', 'Notifications')}
                >
                  <FaBell size={15} />
                  {notifUnreadCount > 0 && (
                    <span className="header-icon-badge">
                      {notifUnreadCount > 99 ? '99+' : notifUnreadCount}
                    </span>
                  )}
                </button>
                {notifOpen && (
                  <NotificationDropdown
                    notifications={notifications}
                    loading={notifLoading}
                    onClose={handleNotifClose}
                    onMarkAsRead={markAsRead}
                    onMarkAllAsRead={markAllAsRead}
                  />
                )}
              </div>
            )}
            {user && (
              <Link to="/messages" className="header-icon-btn" onClick={closeAll} title={t('nav.messages')}>
                <FaEnvelope size={15} />
                {unreadCount > 0 && (
                  <span className="header-icon-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
                )}
              </Link>
            )}

            {/* Online counter (muted) */}
            {onlineCount != null && onlineCount > 0 && (
              <span className="online-counter" title={t('nav.online', '{{count}} online', { count: onlineCount })}>
                <span className="online-counter__dot" />
                {onlineCount}
              </span>
            )}

            {/* Language switcher */}
            <button
              className="lang-switcher"
              onClick={() => {
                const next = i18n.language === 'ru' ? 'en' : 'ru';
                i18n.changeLanguage(next);
                localStorage.setItem('locale', next);
              }}
              title={i18n.language === 'ru' ? 'Switch to English' : 'Переключить на русский'}
            >
              {i18n.language === 'ru' ? 'EN' : 'RU'}
            </button>

            {/* User dropdown / Login */}
            {user ? (
              <div className="dropdown" ref={userMenuRef}>
                <button
                  className="dropdown-toggle nav-user"
                  onClick={() => setUserMenuOpen(!userMenuOpen)}
                >
                  {user.username}{user.ratingBlitz != null && ` (${user.ratingBlitz})`} <span className="dropdown-arrow">&#9662;</span>
                </button>
                {userMenuOpen && (
                  <div className="dropdown-menu dropdown-menu--right">
                    <Link to="/profile" onClick={closeAll}>{t('nav.profile')}</Link>
                    <Link to="/friends" onClick={closeAll}>
                      <FaUserFriends size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
                      {t('nav.friends', 'Friends')}
                    </Link>
                    <Link to="/settings" onClick={closeAll}>{t('nav.settings')}</Link>
                    <button onClick={() => { logout(); closeAll(); }}>{t('nav.logout')}</button>
                  </div>
                )}
              </div>
            ) : (
              <div className="social-login-buttons">
                <a href={`${API_URL}/api/auth/google`} className="social-login-btn social-login-btn--google" aria-label="Google">
                  <FcGoogle size={20} />
                </a>
                <a href={`${API_URL}/api/auth/facebook`} className="social-login-btn social-login-btn--facebook" aria-label="Facebook">
                  <FaFacebook size={20} color="#1877F2" />
                </a>
                <a
                  href="#"
                  className="social-login-btn social-login-btn--telegram"
                  aria-label="Telegram"
                  onClick={(e) => {
                    e.preventDefault();
                    redirectToTelegramOAuth();
                  }}
                >
                  <FaTelegram size={20} color="#26A5E4" />
                </a>
                {isLocalhost && DEV_BYPASS_SECRET && (
                  <a
                    href={`?dev_bypass=${DEV_BYPASS_SECRET}`}
                    className="social-login-btn social-login-btn--dev"
                    aria-label="Dev Bypass"
                    title="Dev Bypass Login"
                  >
                    <FaCode size={20} color="#f59e0b" />
                  </a>
                )}
              </div>
            )}
          </div>
        </nav>
      </header>
      <div className="app-body">
        {user && <Sidebar />}
        <main className="main">
          <Outlet />
        </main>
      </div>
      {user && incoming && (
        <IncomingChallengeToast
          challenge={incoming}
          onAccept={acceptChallenge}
          onDecline={declineChallenge}
        />
      )}
      {user && !hideBottomBar && <MobileBottomBar />}
    </div>
  );
}
