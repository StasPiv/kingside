import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
    const { Outlet, Link } = require('react-router-dom');
    return (
      <div>
        <nav>
          <Link to="/puzzle-rush">Puzzle Rush Nav</Link>
          <Link to="/puzzle-rush/leaderboard">Leaderboard Nav</Link>
        </nav>
        <Outlet />
      </div>
    );
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

  // KS-260: Scenario 1 — direct navigation to /puzzle-rush/leaderboard
  it('renders /puzzle-rush/leaderboard without auth (no redirect)', () => {
    renderApp('/puzzle-rush/leaderboard');
    expect(screen.getByText('Rush Leaderboard')).toBeInTheDocument();
  });

  // KS-260: Scenario 2 — direct navigation to /puzzle-rush (protected)
  it('renders /puzzle-rush for authenticated user', () => {
    mockUseAuth.mockReturnValue({
      user: { id: 'u1', username: 'Test' },
      loading: false,
      token: 'tok',
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
    });
    renderApp('/puzzle-rush');
    expect(screen.getByText('Puzzle Rush')).toBeInTheDocument();
  });

  // KS-260: Scenario 2b — /puzzle-rush redirects to login when not authenticated
  it('redirects /puzzle-rush to /login when not authenticated', () => {
    renderApp('/puzzle-rush');
    expect(screen.getByRole('heading', { name: 'Login' })).toBeInTheDocument();
  });

  // KS-260: Scenario 4 — /puzzle-rush/leaderboard accessible without auth
  // (covered by first leaderboard test above)

  // KS-260: Scenario 5 — /puzzle-rush/leaderboard accessible with auth
  it('renders /puzzle-rush/leaderboard with auth', () => {
    mockUseAuth.mockReturnValue({
      user: { id: 'u1', username: 'Test' },
      loading: false,
      token: 'tok',
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
    });
    renderApp('/puzzle-rush/leaderboard');
    expect(screen.getByText('Rush Leaderboard')).toBeInTheDocument();
  });

  // KS-260: Scenario 6 — page refresh on /puzzle-rush/leaderboard (simulated via direct entry)
  it('renders /puzzle-rush/leaderboard on direct entry (simulates refresh)', () => {
    renderApp('/puzzle-rush/leaderboard');
    expect(screen.getByText('Rush Leaderboard')).toBeInTheDocument();
  });

  // KS-268: QA verification of KS-258 redirect /puzzles/rush → /puzzle-rush
  describe('KS-258 redirect verification', () => {
    it('redirects /puzzles/rush to /puzzle-rush for authenticated user', () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'u1', username: 'Test' },
        loading: false,
        token: 'tok',
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
      });
      renderApp('/puzzles/rush');
      expect(screen.getByText('Puzzle Rush')).toBeInTheDocument();
    });

    it('redirects /puzzles/rush to /puzzle-rush then to /login when not authenticated', () => {
      renderApp('/puzzles/rush');
      expect(screen.getByRole('heading', { name: 'Login' })).toBeInTheDocument();
    });

    it('/puzzle-rush still works directly (not broken by redirect)', () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'u1', username: 'Test' },
        loading: false,
        token: 'tok',
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
      });
      renderApp('/puzzle-rush');
      expect(screen.getByText('Puzzle Rush')).toBeInTheDocument();
    });
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

  // KS-267: Scenario 6 — client-side navigation to /puzzle-rush/leaderboard
  it('navigates to /puzzle-rush/leaderboard via client-side link', () => {
    mockUseAuth.mockReturnValue({
      user: { id: 'u1', username: 'Test' },
      loading: false,
      token: 'tok',
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
    });
    renderApp('/puzzle-rush');
    expect(screen.getByText('Puzzle Rush')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Leaderboard Nav'));
    expect(screen.getByText('Rush Leaderboard')).toBeInTheDocument();
  });

  // KS-267: Navigation from leaderboard back to /puzzle-rush (auth user)
  it('navigates from /puzzle-rush/leaderboard to /puzzle-rush via link', () => {
    mockUseAuth.mockReturnValue({
      user: { id: 'u1', username: 'Test' },
      loading: false,
      token: 'tok',
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
    });
    renderApp('/puzzle-rush/leaderboard');
    expect(screen.getByText('Rush Leaderboard')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Puzzle Rush Nav'));
    expect(screen.getByText('Puzzle Rush')).toBeInTheDocument();
  });

  // KS-267: /puzzle-rush/leaderboard client-side nav without auth
  it('navigates to /puzzle-rush/leaderboard via link without auth', () => {
    renderApp('/lobby'); // redirected to /login
    fireEvent.click(screen.getByText('Leaderboard Nav'));
    expect(screen.getByText('Rush Leaderboard')).toBeInTheDocument();
  });
});
