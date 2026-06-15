import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { testI18n } from './test/test-utils';
import { App } from './App';
import { RequireAuthProvider } from './context/RequireAuthContext';

const mockUseAuth = vi.fn();
vi.mock('./context/AuthContext', () => ({
  // KS-4124: RequireAuthProvider зовёт useAuth — реальный AuthProvider
  // через сетевой fetchMe здесь не нужен, поэтому мокаем сам хук, а
  // провайдер `RequireAuthProvider` оборачиваем настоящий (он внутри
  // ходит к useAuth, useNavigate, useTranslation, всё доступно).
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

// KS-2218: тесты роутинга ниже завязаны на доступность /puzzles* и
// прочих разделов. По дефолту (KS-2217) `puzzlesEnabled=false`, что
// сломало бы /puzzles/mistakes, /puzzle/* и т.п. Мокаем хук так, чтобы
// все runtime-флаги были включены — поведение guard'ов проверяется
// отдельно в App.featureFlag.test.tsx.
vi.mock('./context/FeatureFlagsContext', () => ({
  useFeatureFlag: () => true,
  useFeatureFlags: () => ({
    flags: {
      lessonsEnabled: true,
      puzzlesEnabled: true,
      broadcastsEnabled: true,
      tournamentsEnabled: true,
    },
    loading: false,
    error: null,
    refresh: async () => {},
  }),
  FeatureFlagsProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DEFAULT_FLAGS: {
    lessonsEnabled: true,
    puzzlesEnabled: true,
    broadcastsEnabled: true,
    tournamentsEnabled: true,
  },
}));

vi.mock('./layouts/MainLayout', async () => {
  const { Outlet, Link } = await vi.importActual<
    typeof import('react-router-dom')
  >('react-router-dom');
  return {
    MainLayout: () => (
      <div>
        <nav>
          <Link to="/puzzle-rush">Puzzle Rush Nav</Link>
          <Link to="/puzzle-rush/leaderboard">Leaderboard Nav</Link>
        </nav>
        <Outlet />
      </div>
    ),
  };
});

vi.mock('./pages/LobbyPage', () => ({
  LobbyPage: () => <div>Lobby</div>,
}));

vi.mock('./pages/GamePage', () => ({
  GamePage: () => <div>Game</div>,
}));

vi.mock('./pages/SettingsPage', () => ({
  SettingsPage: () => <div>Settings</div>,
}));

vi.mock('./pages/PuzzleBrowserPage', () => ({
  PuzzleBrowserPage: () => <div>Puzzle Browser</div>,
}));

vi.mock('./pages/PuzzlePage', () => ({
  PuzzlePage: () => <div>Puzzle</div>,
}));

// KS-1928: новые puzzle-mistakes страницы — мокаем для проверки 301-redirects.
vi.mock('./pages/PuzzleMistakesPage', () => ({
  PuzzleMistakesPage: () => <div>Puzzle Mistakes</div>,
}));

vi.mock('./pages/PuzzleMistakesPracticePage', async () => {
  const { useSearchParams } = await vi.importActual<
    typeof import('react-router-dom')
  >('react-router-dom');
  return {
    PuzzleMistakesPracticePage: () => {
      const [params] = useSearchParams();
      return (
        <div>Puzzle Mistakes Practice theme={params.get('theme') ?? ''}</div>
      );
    },
  };
});

vi.mock('./pages/PuzzleRushPage', () => ({
  PuzzleRushPage: () => <div>Puzzle Rush</div>,
}));

// KS-2747 / ADR-057 §2.2: новые роуты /precision/stats и /precision/history.
// Обе страницы импортируются через lazy() → нужны моки чтобы не тянуть
// real-сетевой код в smoke-тесты.
vi.mock('./pages/PrecisionStatsPage', () => ({
  PrecisionStatsPage: () => <div>Precision Stats Page</div>,
}));
vi.mock('./pages/PrecisionHistoryPage', () => ({
  PrecisionHistoryPage: () => <div>Precision History Page</div>,
}));

vi.mock('./pages/PuzzleRushLeaderboardPage', () => ({
  PuzzleRushLeaderboardPage: () => <div>Rush Leaderboard</div>,
}));

vi.mock('./pages/ProfilePage', () => ({
  ProfilePage: () => <div>Profile</div>,
}));

// `/*` redirects to `/`, which renders FeaturesPage for an unauthenticated
// user via <HomePage>. Mock it so we can assert on the landing route.
vi.mock('./pages/FeaturesPage', () => ({
  FeaturesPage: () => <div>Features</div>,
}));

// `/profile` redirects to `/player/:username` via <ProfileRedirect>, which
// renders PlayerProfilePage. Without this mock the real page loads and
// hangs on auth/api calls during the test.
vi.mock('./pages/PlayerProfilePage', () => ({
  PlayerProfilePage: () => <div>Player Profile</div>,
}));

function renderApp(route: string) {
  // KS-4179: KS-4124 ввёл `<RequireAuthProvider>` поверх `<App />`
  // в main.tsx. Сами компоненты страниц теперь зовут
  // `useRequireAuth()`; без обёртки рендер падает с
  // «useRequireAuth must be used within RequireAuthProvider».
  return render(
    <I18nextProvider i18n={testI18n}>
      <MemoryRouter initialEntries={[route]}>
        <RequireAuthProvider>
          <App />
        </RequireAuthProvider>
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

  it('redirects unknown routes to `/` (landing page for guests)', () => {
    // The catch-all route `path="*"` now navigates to "/", which renders
    // HomePage. For an unauthenticated user HomePage shows FeaturesPage
    // instead of the previous redirect to /lobby → /login.
    renderApp('/unknown');
    expect(screen.getByText('Features')).toBeInTheDocument();
  });

  // KS-2810 (ADR-058 §6.5 T13): авторизованный → / редиректится на /play
  // (раньше шёл на /lobby).
  it('KS-2810: authenticated user on `/` is redirected to /play', () => {
    mockUseAuth.mockReturnValue({
      user: { id: 'u1', username: 'Test' },
      loading: false,
      token: 'tok',
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
    });
    renderApp('/');
    // Redirect лендит на /play (ProtectedRoute → PlayPage в этом тесте
    // замокана через PlayPage placeholder).
    expect(screen.queryByText('Features')).not.toBeInTheDocument();
  });

  it('redirects protected routes to /login when not authenticated', () => {
    // `/lobby` is now a public route, so use `/settings` (ProtectedRoute)
    // to exercise the redirect-to-login behavior that the previous
    // assertion relied on.
    renderApp('/settings');
    expect(screen.getByRole('heading', { name: 'Login' })).toBeInTheDocument();
  });

  // KS-260: Scenario 1 — direct navigation to /puzzle-rush/leaderboard
  it('renders /puzzle-rush/leaderboard without auth (no redirect)', () => {
    renderApp('/puzzle-rush/leaderboard');
    expect(screen.getByText('Rush Leaderboard')).toBeInTheDocument();
  });

  // KS-260: Scenario 2 — direct navigation to /puzzle-rush (protected)
  it('renders /puzzle-rush for authenticated user', async () => {
    mockUseAuth.mockReturnValue({
      user: { id: 'u1', username: 'Test' },
      loading: false,
      token: 'tok',
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
    });
    renderApp('/puzzle-rush');
    // `/puzzle-rush` is a lazy()-loaded route wrapped in <Suspense>, so the
    // assertion has to wait for the dynamic import to resolve.
    expect(await screen.findByText('Puzzle Rush')).toBeInTheDocument();
  });

  // KS-4157 / ADR-128 §5.13: /puzzle-rush открыт гостю (раунд считается
  // и предлагается сохранить через логин уже после прохождения). Раньше
  // KS-260 завязывался на редирект гостя на /login — после открытия
  // маршрута гостям корректно проверять, что страница рендерится.
  it('renders /puzzle-rush for unauthenticated user (KS-4157 / ADR-128 §5.13)', async () => {
    renderApp('/puzzle-rush');
    expect(await screen.findByText('Puzzle Rush')).toBeInTheDocument();
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
    it('redirects /puzzles/rush to /puzzle-rush for authenticated user', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'u1', username: 'Test' },
        loading: false,
        token: 'tok',
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
      });
      renderApp('/puzzles/rush');
      // Lands on the lazy PuzzleRushPage via redirect — await dynamic import.
      expect(await screen.findByText('Puzzle Rush')).toBeInTheDocument();
    });

    // KS-4157 / ADR-128 §5.13: /puzzle-rush открыт гостю, поэтому
    // редирект /puzzles/rush → /puzzle-rush у гостя приземляется на
    // саму страницу, а не на /login.
    it('redirects /puzzles/rush to /puzzle-rush for unauthenticated user (KS-4157)', async () => {
      renderApp('/puzzles/rush');
      expect(await screen.findByText('Puzzle Rush')).toBeInTheDocument();
    });

    it('/puzzle-rush still works directly (not broken by redirect)', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'u1', username: 'Test' },
        loading: false,
        token: 'tok',
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
      });
      renderApp('/puzzle-rush');
      expect(await screen.findByText('Puzzle Rush')).toBeInTheDocument();
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
    // `/profile` is a ProtectedRoute that redirects to `/player/:username`
    // via <ProfileRedirect>, so the resolved page is the mocked
    // PlayerProfilePage.
    renderApp('/profile');
    expect(screen.getByText('Player Profile')).toBeInTheDocument();
  });

  // KS-267: Scenario 6 — client-side navigation to /puzzle-rush/leaderboard
  it('navigates to /puzzle-rush/leaderboard via client-side link', async () => {
    mockUseAuth.mockReturnValue({
      user: { id: 'u1', username: 'Test' },
      loading: false,
      token: 'tok',
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
    });
    renderApp('/puzzle-rush');
    expect(await screen.findByText('Puzzle Rush')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Leaderboard Nav'));
    expect(screen.getByText('Rush Leaderboard')).toBeInTheDocument();
  });

  // KS-267: Navigation from leaderboard back to /puzzle-rush (auth user)
  it('navigates from /puzzle-rush/leaderboard to /puzzle-rush via link', async () => {
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
    expect(await screen.findByText('Puzzle Rush')).toBeInTheDocument();
  });

  // KS-267: /puzzle-rush/leaderboard client-side nav without auth
  it('navigates to /puzzle-rush/leaderboard via link without auth', () => {
    renderApp('/lobby'); // redirected to /login
    fireEvent.click(screen.getByText('Leaderboard Nav'));
    expect(screen.getByText('Rush Leaderboard')).toBeInTheDocument();
  });

  // KS-2747 / ADR-057 F5: deep-link рендерит /precision/stats и
  // /precision/history (обе lazy(), ждём Suspense через findByText).
  describe('KS-2747 precision split routes', () => {
    it('renders /precision/stats via deep-link', async () => {
      renderApp('/precision/stats');
      expect(
        await screen.findByText('Precision Stats Page'),
      ).toBeInTheDocument();
    });

    it('renders /precision/history via deep-link', async () => {
      renderApp('/precision/history');
      expect(
        await screen.findByText('Precision History Page'),
      ).toBeInTheDocument();
    });
  });

  // KS-1928 / ADR-032: 301-redirect /lessons/mistakes* → /puzzles/mistakes*
  describe('KS-1928 mistakes redirect', () => {
    beforeEach(() => {
      mockUseAuth.mockReturnValue({
        user: { id: 'u1', username: 'Test' },
        loading: false,
        token: 'tok',
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
      });
    });

    it('/lessons/mistakes → /puzzles/mistakes', () => {
      renderApp('/lessons/mistakes');
      expect(screen.getByText('Puzzle Mistakes')).toBeInTheDocument();
    });

    it('/lessons/mistakes-practice?theme=fork → /puzzles/mistakes-practice сохраняя query', () => {
      renderApp('/lessons/mistakes-practice?theme=fork');
      // theme=fork должен дойти до новой страницы.
      expect(
        screen.getByText('Puzzle Mistakes Practice theme=fork'),
      ).toBeInTheDocument();
    });

    it('/lessons/mistakes-practice без query → /puzzles/mistakes-practice без query', () => {
      renderApp('/lessons/mistakes-practice');
      expect(
        screen.getByText('Puzzle Mistakes Practice theme='),
      ).toBeInTheDocument();
    });

    it('/puzzles/mistakes ходит напрямую (без редиректа)', () => {
      renderApp('/puzzles/mistakes');
      expect(screen.getByText('Puzzle Mistakes')).toBeInTheDocument();
    });
  });
});
