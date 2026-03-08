import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { testI18n } from './test/test-utils';
import { App } from './App';

vi.mock('./context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    token: null,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('./layouts/MainLayout', () => ({
  MainLayout: () => {
    const { Outlet } = require('react-router-dom');
    return <Outlet />;
  },
}));

vi.mock('./pages/LobbyPage', () => ({
  LobbyPage: () => <div>Lobby</div>,
}));

vi.mock('./pages/GamePage', () => ({
  GamePage: () => <div>Game</div>,
}));

vi.mock('./pages/SettingsPage', () => ({
  SettingsPage: () => <div>Settings</div>,
}));

vi.mock('./pages/DailyPuzzlePage', () => ({
  DailyPuzzlePage: () => <div>Daily Puzzle</div>,
}));

vi.mock('./pages/PuzzleBrowserPage', () => ({
  PuzzleBrowserPage: () => <div>Puzzle Browser</div>,
}));

vi.mock('./pages/PuzzlePage', () => ({
  PuzzlePage: () => <div>Puzzle</div>,
}));

function renderApp(route: string) {
  return render(
    <I18nextProvider i18n={testI18n}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('App routing', () => {
  it('renders login page at /login for unauthenticated user', () => {
    renderApp('/login');
    expect(screen.getByRole('heading', { name: 'Login' })).toBeInTheDocument();
  });

  it('redirects to /lobby for unknown routes', () => {
    renderApp('/unknown');
    // unauthenticated user on /lobby gets redirected to /login
    expect(screen.getByRole('heading', { name: 'Login' })).toBeInTheDocument();
  });

  it('redirects protected routes to /login when not authenticated', () => {
    renderApp('/lobby');
    expect(screen.getByRole('heading', { name: 'Login' })).toBeInTheDocument();
  });
});
