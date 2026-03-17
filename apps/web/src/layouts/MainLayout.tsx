import { useState, useRef, useEffect } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FcGoogle } from 'react-icons/fc';
import { FaFacebook, FaTelegram, FaCode } from 'react-icons/fa';
import { useAuth } from '../context/AuthContext';

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

  const userMenuRef = useRef<HTMLDivElement>(null);

  useClickOutside(userMenuRef, () => setUserMenuOpen(false));

  const closeAll = () => {
    setUserMenuOpen(false);
    setMobileMenuOpen(false);
  };

  return (
    <div className="app">
      <header className="header">
        <nav>
          <Link to="/lobby" className="logo" onClick={closeAll}>Kingside</Link>

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
              <Link to="/players" className="nav-link" onClick={closeAll}>{t('nav.players')}</Link>
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
    </div>
  );
}
