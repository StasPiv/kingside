import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function MainLayout() {
  const { user, logout } = useAuth();

  return (
    <div className="app">
      <header className="header">
        <nav>
          <Link to="/lobby" className="logo">Kingside</Link>
          <div className="nav-links">
            {user ? (
              <>
                <span className="nav-user">{user.username} ({user.rating})</span>
                <button className="nav-btn" onClick={logout}>Выход</button>
              </>
            ) : (
              <>
                <Link to="/login">Вход</Link>
                <Link to="/register">Регистрация</Link>
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
