import { useState, useRef, useEffect, useCallback } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FcGoogle } from 'react-icons/fc';
import { FaFacebook, FaTelegram, FaCode, FaEnvelope, FaBell } from 'react-icons/fa';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { messagesSocket } from '../socket';
import { MessageEvents } from '@kingside/shared';
import { useChallenge } from '../hooks/useChallenge';
import { useNotifications } from '../hooks/useNotifications';
import { IncomingChallengeToast } from '../components/IncomingChallengeToast';
import { NotificationDropdown } from '../components/NotificationDropdown';

const DEV_BYPASS_SECRET = import.meta.env.VITE_DEV_BYPASS_SECRET;
const isLocalhost = window.location.hostname === 'localhost';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const TELEGRAM_BOT_ID = import.meta.env.VITE_TELEGRAM_BOT_ID ?? '8447702776';

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
  const { t } = useTranslation();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
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

  const handleNotifToggle = useCallback(() => {
    setNotifOpen((prev) => {
      if (!prev) fetchNotifications();
      return !prev;
    });
  }, [fetchNotifications]);

  const handleNotifClose = useCallback(() => setNotifOpen(false), []);

  const userMenuRef = useRef<HTMLDivElement>(null);

  useClickOutside(userMenuRef, () => setUserMenuOpen(false));

  // Fetch unread count on login
  useEffect(() => {
    if (!user) { setUnreadCount(0); return; }
    api.get<{ count: number }>('/api/messages/unread-count')
      .then((data) => setUnreadCount(data.count))
      .catch(() => {});
  }, [user]);

  // WebSocket: update badge on new message
  useEffect(() => {
    if (!user) return;
    const token = localStorage.getItem('token');
    if (!token) return;

    if (!messagesSocket.connected) {
      messagesSocket.auth = { token };
      messagesSocket.connect();
    }

    const onNewMessage = () => {
      setUnreadCount((prev) => prev + 1);
    };
    messagesSocket.on(MessageEvents.NEW_MESSAGE, onNewMessage);
    return () => { messagesSocket.off(MessageEvents.NEW_MESSAGE, onNewMessage); };
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

  const closeAll = () => {
    setUserMenuOpen(false);
    setMobileMenuOpen(false);
  };

  return (
    <div className="app">
      <header className="header">
        <nav>
          <Link to="/lobby" className="logo" onClick={closeAll}>Kingside{appVersion ? ` (v.${appVersion})` : ''}</Link>

          {onlineCount != null && onlineCount > 0 && (
            <span className="online-counter" title={t('nav.online', '{{count}} online', { count: onlineCount })}>
              <span className="online-counter__dot" />
              {onlineCount}
            </span>
          )}

          <button
            className="hamburger"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Menu"
          >
            <span />
            <span />
            <span />
          </button>

          <div className={`nav-menu${mobileMenuOpen ? ' nav-menu--open' : ''}`}>
            <div className="nav-links">
              {user && (
                <div className="nav-notification-wrapper">
                  <button
                    className="nav-link nav-notification-btn"
                    onClick={handleNotifToggle}
                    title={t('notifications.title', 'Notifications')}
                  >
                    <FaBell size={16} />
                    {notifUnreadCount > 0 && (
                      <span className="nav-notification-badge">
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
                <Link to="/friends" className="nav-link" onClick={closeAll} title={t('nav.friends', 'Friends')}>
                  👥
                </Link>
              )}
              {user && (
                <Link to="/messages" className="nav-link nav-messages-link" onClick={closeAll} title={t('nav.messages')}>
                  <FaEnvelope size={16} />
                  {unreadCount > 0 && (
                    <span className="nav-messages-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
                  )}
                </Link>
              )}
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
                      const origin = window.location.origin;
                      const returnTo = `${origin}/login`;
                      window.location.href =
                        `https://oauth.telegram.org/auth` +
                        `?bot_id=${TELEGRAM_BOT_ID}` +
                        `&origin=${encodeURIComponent(origin)}` +
                        `&return_to=${encodeURIComponent(returnTo)}`;
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
          </div>
        </nav>
      </header>
      <main className="main">
        <Outlet />
      </main>
      {user && incoming && (
        <IncomingChallengeToast
          challenge={incoming}
          onAccept={acceptChallenge}
          onDecline={declineChallenge}
        />
      )}
    </div>
  );
}
