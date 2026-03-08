import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { testI18n } from './test/test-utils';
import { App } from './App';

const mockUseAuth = vi.fn();
vi.mock('./context/AuthContext', () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
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

vi.mock('./pages/PuzzleRushPage', () => ({
  PuzzleRushPage: () => <div>Puzzle Rush</div>,
}));

vi.mock('./pages/PuzzleRushLeaderboardPage', () => ({
  PuzzleRushLeaderboardPage: () => <div>Rush Leaderboard</div>,
}));

vi.mock('./pages/ProfilePage', () => ({
  ProfilePage: () => <div>Profile</div>,
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
  beforeEach(() => {
    mockUseAuth.mockReturnValue({
      user: null,
      loading: false,
      token: null,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
    });
  });

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

  it('renders /puzzle-rush/leaderboard without auth (no redirect)', () => {
    renderApp('/puzzle-rush/leaderboard');
    expect(screen.getByText('Rush Leaderboard')).toBeInTheDocument();
  });

  it('redirects /profile to /login when not authenticated', () => {
    renderApp('/profile');
    expect(screen.getByRole('heading', { name: 'Login' })).toBeInTheDocument();
  });

  it('renders /profile for authenticated user', () => {
    mockUseAuth.mockReturnValue({
      user: { id: 'u1', username: 'Test' },
      loading: false,
      token: 'tok',
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
    });
    renderApp('/profile');
    expect(screen.getByText('Profile')).toBeInTheDocument();
  });
});
