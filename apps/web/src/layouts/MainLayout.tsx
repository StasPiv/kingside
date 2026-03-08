import { Link, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';

export function MainLayout() {
  const { user, logout } = useAuth();
  const { t } = useTranslation();

  return (
    <div className="app">
      <header className="header">
        <nav>
          <Link to="/lobby" className="logo">Kingside</Link>
          <Link to="/puzzle-rush">{t('nav.puzzleRush')}</Link>
          <div className="nav-links">
            {user ? (
              <>
                <span className="nav-user">{user.username}{user.ratingBlitz != null && ` (${user.ratingBlitz})`}</span>
                <Link to="/settings">{t('nav.settings')}</Link>
                <button className="nav-btn" onClick={logout}>{t('nav.logout')}</button>
              </>
            ) : (
              <>
                <Link to="/login">{t('nav.login')}</Link>
                <Link to="/register">{t('nav.register')}</Link>
              </>
            )}
          </div>
        </nav>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
