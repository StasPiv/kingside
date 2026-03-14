import { useState, useRef, useEffect } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';

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
  const [trainOpen, setTrainOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const trainRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useClickOutside(trainRef, () => setTrainOpen(false));
  useClickOutside(userMenuRef, () => setUserMenuOpen(false));

  const closeAll = () => {
    setTrainOpen(false);
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
            <div className="dropdown" ref={trainRef}>
              <button
                className="dropdown-toggle"
                onClick={() => setTrainOpen(!trainOpen)}
              >
                {t('nav.train')} <span className="dropdown-arrow">&#9662;</span>
              </button>
              {trainOpen && (
                <div className="dropdown-menu">
                  <Link to="/puzzles" onClick={closeAll}>{t('nav.puzzles')}</Link>
                  <Link to="/daily" onClick={closeAll}>{t('nav.dailyPuzzle')}</Link>
                  <Link to="/puzzle-rush" onClick={closeAll}>{t('nav.puzzleRush')}</Link>
                </div>
              )}
            </div>

            <Link to="/broadcasts" className="nav-link" onClick={closeAll}>{t('nav.broadcasts')}</Link>

            <div className="nav-links">
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
                <>
                  <Link to="/login" onClick={closeAll}>{t('nav.login')}</Link>
                  <Link to="/register" onClick={closeAll}>{t('nav.register')}</Link>
                </>
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
