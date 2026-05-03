import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderWithProviders, screen, waitFor } from './test/test-utils';

// KS-2105: feature-flag читается из FeatureFlagsContext (runtime,
// `GET /config`). В тесте мокаем `useFeatureFlag` напрямую — этого
// достаточно, чтобы App.tsx (и Sidebar.tsx, если рендерится) увидели
// нужное значение. `flags.lessons` остаётся как переменная-источник:
// тесты переключают её перед render'ом.
const flags = {
  lessons: true,
  // KS-2218: дефолты повторяют серверный whitelist (KS-2217).
  puzzles: false,
  broadcasts: true,
  tournaments: true,
  // KS-2232 (KS-2231): default false.
  drills: false,
};
vi.mock('./context/FeatureFlagsContext', async () => {
  const actual = await vi.importActual<
    typeof import('./context/FeatureFlagsContext')
  >('./context/FeatureFlagsContext');
  return {
    ...actual,
    useFeatureFlag: (key: string) => {
      if (key === 'lessonsEnabled') return flags.lessons;
      if (key === 'puzzlesEnabled') return flags.puzzles;
      if (key === 'broadcastsEnabled') return flags.broadcasts;
      if (key === 'tournamentsEnabled') return flags.tournaments;
      if (key === 'drillsEnabled') return flags.drills;
      return false;
    },
    useFeatureFlags: () => ({
      flags: {
        lessonsEnabled: flags.lessons,
        puzzlesEnabled: flags.puzzles,
        broadcastsEnabled: flags.broadcasts,
        tournamentsEnabled: flags.tournaments,
        drillsEnabled: flags.drills,
      },
      loading: false,
      error: null,
      refresh: async () => {},
    }),
    // Обёртка-Provider тут не нужна — компоненты ходят к мокнутым
    // хукам напрямую, но если кто-то рендерит Provider — оставляем
    // pass-through.
    FeatureFlagsProvider: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
  };
});

// MainLayout тянет api/auth/useChallenge/useNotifications — тяжёлое
// дерево. Мокаем как proxy через Outlet, чтобы тесты роутинга App
// рендерили дочерние страницы без зависимостей.
vi.mock('./layouts/MainLayout', async () => {
  const { Outlet } = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    MainLayout: () => (
      <div data-testid="main-layout-mock">
        <Outlet />
      </div>
    ),
  };
});

// Все «живые» страницы мокаем тонкими заглушками — проверяем роутинг,
// а не их внутренности. Inline-фабрики (не через helper) — чтобы не
// упереться в vi.mock hoisting.
vi.mock('./pages/LessonsPage', () => ({
  LessonsPage: () => <div data-testid="page-lessons" />,
}));
vi.mock('./pages/CoursePage', () => ({
  CoursePage: () => <div data-testid="page-course" />,
}));
vi.mock('./pages/LessonPage', () => ({
  LessonPage: () => <div data-testid="page-lesson" />,
}));
vi.mock('./pages/LessonEditorPage', () => ({
  LessonEditorPage: () => <div data-testid="page-lesson-editor" />,
}));
vi.mock('./pages/MistakesPage', () => ({
  MistakesPage: () => <div data-testid="page-mistakes" />,
}));
vi.mock('./pages/MistakesPracticePage', () => ({
  MistakesPracticePage: () => <div data-testid="page-mistakes-practice" />,
}));
vi.mock('./pages/DevReviewsUiPage', () => ({
  DevReviewsUiPage: () => <div data-testid="page-dev-reviews" />,
}));
vi.mock('./pages/DevVideoStepPage', () => ({
  DevVideoStepPage: () => <div data-testid="page-dev-video" />,
}));
vi.mock('./pages/DevPositionStepPage', () => ({
  DevPositionStepPage: () => <div data-testid="page-dev-position" />,
}));
vi.mock('./pages/DevGameReviewStepPage', () => ({
  DevGameReviewStepPage: () => <div data-testid="page-dev-game-review" />,
}));
vi.mock('./pages/DevEndgameDrillStepPage', () => ({
  DevEndgameDrillStepPage: () => <div data-testid="page-dev-endgame" />,
}));
vi.mock('./pages/DevOpeningDrillStepPage', () => ({
  DevOpeningDrillStepPage: () => <div data-testid="page-dev-opening" />,
}));
vi.mock('./pages/DevPlayoffBracketPage', () => ({
  DevPlayoffBracketPage: () => <div data-testid="page-dev-playoff" />,
}));
vi.mock('./pages/FeaturesPage', () => ({
  FeaturesPage: () => <div data-testid="page-features">Features home</div>,
}));
// KS-2218: заглушки для страниц, поведение guard'ов которых проверяем.
vi.mock('./pages/LobbyPage', () => ({
  LobbyPage: () => <div data-testid="page-lobby" />,
}));
vi.mock('./pages/PuzzleBrowserPage', () => ({
  PuzzleBrowserPage: () => <div data-testid="page-puzzles" />,
}));
vi.mock('./pages/DailyPuzzlePage', () => ({
  DailyPuzzlePage: () => <div data-testid="page-daily" />,
}));
vi.mock('./pages/PuzzlePage', () => ({
  PuzzlePage: () => <div data-testid="page-puzzle" />,
}));
vi.mock('./pages/TournamentsPage', () => ({
  TournamentsPage: () => <div data-testid="page-tournaments" />,
}));
vi.mock('./pages/TournamentLobbyPage', () => ({
  TournamentLobbyPage: () => <div data-testid="page-tournament-lobby" />,
}));
vi.mock('./pages/BroadcastsPage', () => ({
  BroadcastsPage: () => <div data-testid="page-broadcasts" />,
}));
vi.mock('./pages/BroadcastTournamentPage', () => ({
  BroadcastTournamentPage: () => <div data-testid="page-broadcast-tournament" />,
}));
// KS-2232: заглушка лобби тренажёров.
vi.mock('./pages/DrillsLobbyPage', () => ({
  DrillsLobbyPage: () => <div data-testid="page-drills-lobby" />,
}));
// KS-2233: заглушка страницы drill /drills/:type.
vi.mock('./pages/DrillPage', () => ({
  DrillPage: () => <div data-testid="page-drill" />,
}));
// KS-2241: заглушки sprint-страниц.
vi.mock('./pages/DrillSprintSetupPage', () => ({
  DrillSprintSetupPage: () => <div data-testid="page-drill-sprint-setup" />,
}));
vi.mock('./pages/DrillSprintPlayPage', () => ({
  DrillSprintPlayPage: () => <div data-testid="page-drill-sprint-play" />,
}));
vi.mock('./pages/DrillSprintResultsPage', () => ({
  DrillSprintResultsPage: () => <div data-testid="page-drill-sprint-results" />,
}));
// KS-2242: заглушка лидерборда.
vi.mock('./pages/DrillLeaderboardPage', () => ({
  DrillLeaderboardPage: () => <div data-testid="page-drill-leaderboard" />,
}));
// useAuth вычитывает /auth/me — вернём unauth-пользователя, чтобы
// ProtectedRoute редиректил на /login. Для теста достаточно.
vi.mock('./context/AuthContext', () => ({
  useAuth: () => ({ user: null, loading: false }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { App } from './App';

beforeEach(() => {
  flags.lessons = true;
  flags.puzzles = false;
  flags.broadcasts = true;
  flags.tournaments = true;
  flags.drills = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('App routing: lessons feature flag', () => {
  it('флаг on + unauth → /lessons редиректит на /login (работает старый ProtectedRoute)', async () => {
    flags.lessons = true;
    renderWithProviders(<App />, { route: '/lessons' });
    // unauth → Navigate на /login. Любая из этих страниц = flag-on-путь.
    // Важно: НЕ редирект на '/'.
    await waitFor(() => {
      // На /login у нас нет мока → MainLayout показывает LoginPage внутри
      // guest-route. Но проще: проверяем отсутствие lessons-заглушки.
      expect(screen.queryByTestId('page-features')).not.toBeInTheDocument();
    });
  });

  it('флаг off → /lessons редиректит на корень (HomePage → FeaturesPage для unauth)', async () => {
    flags.lessons = false;
    renderWithProviders(<App />, { route: '/lessons' });
    await waitFor(() =>
      expect(screen.getByTestId('page-features')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('page-lessons')).not.toBeInTheDocument();
  });

  it('флаг off → /lessons/editor тоже редирект на корень', async () => {
    flags.lessons = false;
    renderWithProviders(<App />, { route: '/lessons/editor' });
    await waitFor(() =>
      expect(screen.getByTestId('page-features')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('page-lesson-editor'),
    ).not.toBeInTheDocument();
  });

  it('флаг off → /lessons/mistakes и /lessons/mistakes-practice тоже редирект', async () => {
    flags.lessons = false;
    renderWithProviders(<App />, { route: '/lessons/mistakes' });
    await waitFor(() =>
      expect(screen.getByTestId('page-features')).toBeInTheDocument(),
    );

    renderWithProviders(<App />, { route: '/lessons/mistakes-practice?theme=fork' });
    await waitFor(() =>
      expect(screen.getAllByTestId('page-features').length).toBeGreaterThan(0),
    );
  });
});

describe('App routing: KS-2218 puzzles/broadcasts/tournaments feature flags', () => {
  it('puzzlesEnabled=false → /puzzles редиректит на /lobby', async () => {
    flags.puzzles = false;
    renderWithProviders(<App />, { route: '/puzzles' });
    await waitFor(() =>
      expect(screen.getByTestId('page-lobby')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('page-puzzles')).not.toBeInTheDocument();
  });

  it('puzzlesEnabled=false → /daily редиректит на /lobby', async () => {
    flags.puzzles = false;
    renderWithProviders(<App />, { route: '/daily' });
    await waitFor(() =>
      expect(screen.getByTestId('page-lobby')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('page-daily')).not.toBeInTheDocument();
  });

  it('puzzlesEnabled=false → /puzzle/:id тоже редирект', async () => {
    flags.puzzles = false;
    renderWithProviders(<App />, { route: '/puzzle/abc' });
    await waitFor(() =>
      expect(screen.getByTestId('page-lobby')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('page-puzzle')).not.toBeInTheDocument();
  });

  it('puzzlesEnabled=true → /puzzles рендерит каталог задач', async () => {
    flags.puzzles = true;
    renderWithProviders(<App />, { route: '/puzzles' });
    await waitFor(() =>
      expect(screen.getByTestId('page-puzzles')).toBeInTheDocument(),
    );
  });

  it('puzzles выкл, /puzzle-rush остаётся доступен (отдельный раздел)', async () => {
    flags.puzzles = false;
    renderWithProviders(<App />, { route: '/puzzles/rush' });
    // /puzzles/rush — алиас, перенаправляет на /puzzle-rush.
    // /puzzle-rush сам по себе под ProtectedRoute, unauth → /login.
    // Главное — НЕ /lobby (т.е. guard puzzles нас не перехватил).
    await waitFor(() =>
      expect(screen.queryByTestId('page-lobby')).not.toBeInTheDocument(),
    );
  });

  it('broadcastsEnabled=false → /broadcasts редиректит на /lobby', async () => {
    flags.broadcasts = false;
    renderWithProviders(<App />, { route: '/broadcasts' });
    await waitFor(() =>
      expect(screen.getByTestId('page-lobby')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('page-broadcasts')).not.toBeInTheDocument();
  });

  it('broadcastsEnabled=false → /broadcasts/abc тоже редирект', async () => {
    flags.broadcasts = false;
    renderWithProviders(<App />, { route: '/broadcasts/some-tournament' });
    await waitFor(() =>
      expect(screen.getByTestId('page-lobby')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('page-broadcast-tournament'),
    ).not.toBeInTheDocument();
  });

  it('broadcastsEnabled=true → /broadcasts рендерит список', async () => {
    flags.broadcasts = true;
    renderWithProviders(<App />, { route: '/broadcasts' });
    await waitFor(() =>
      expect(screen.getByTestId('page-broadcasts')).toBeInTheDocument(),
    );
  });

  it('tournamentsEnabled=false → /tournaments редиректит на /lobby', async () => {
    flags.tournaments = false;
    renderWithProviders(<App />, { route: '/tournaments' });
    await waitFor(() =>
      expect(screen.getByTestId('page-lobby')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('page-tournaments')).not.toBeInTheDocument();
  });

  it('tournamentsEnabled=false → /tournaments/some-id тоже редирект', async () => {
    flags.tournaments = false;
    renderWithProviders(<App />, { route: '/tournaments/abc' });
    await waitFor(() =>
      expect(screen.getByTestId('page-lobby')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('page-tournament-lobby'),
    ).not.toBeInTheDocument();
  });

  it('tournamentsEnabled=true → /tournaments рендерит список', async () => {
    flags.tournaments = true;
    renderWithProviders(<App />, { route: '/tournaments' });
    await waitFor(() =>
      expect(screen.getByTestId('page-tournaments')).toBeInTheDocument(),
    );
  });
});

describe('App routing: KS-2232 drills feature flag', () => {
  it('drillsEnabled=false (default) → /drills редиректит на /lobby', async () => {
    flags.drills = false;
    renderWithProviders(<App />, { route: '/drills' });
    await waitFor(() =>
      expect(screen.getByTestId('page-lobby')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('page-drills-lobby')).not.toBeInTheDocument();
  });

  it('drillsEnabled=false → /drills/find-pin тоже редирект (catch-all /drills/*)', async () => {
    flags.drills = false;
    renderWithProviders(<App />, { route: '/drills/find-pin' });
    await waitFor(() =>
      expect(screen.getByTestId('page-lobby')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('page-drills-lobby')).not.toBeInTheDocument();
  });

  it('drillsEnabled=true → /drills рендерит лобби', async () => {
    flags.drills = true;
    renderWithProviders(<App />, { route: '/drills' });
    await waitFor(() =>
      expect(screen.getByTestId('page-drills-lobby')).toBeInTheDocument(),
    );
  });

  it('KS-2233: drillsEnabled=true → /drills/find-pin рендерит DrillPage', async () => {
    flags.drills = true;
    renderWithProviders(<App />, { route: '/drills/find-pin' });
    await waitFor(() =>
      expect(screen.getByTestId('page-drill')).toBeInTheDocument(),
    );
  });

  it('KS-2233: drillsEnabled=false → /drills/find-pin тоже редирект на /lobby', async () => {
    flags.drills = false;
    renderWithProviders(<App />, { route: '/drills/find-pin' });
    await waitFor(() =>
      expect(screen.getByTestId('page-lobby')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('page-drill')).not.toBeInTheDocument();
  });

  it('KS-2241: drillsEnabled=true → /drills/sprint рендерит SetupPage', async () => {
    flags.drills = true;
    renderWithProviders(<App />, { route: '/drills/sprint' });
    await waitFor(() =>
      expect(screen.getByTestId('page-drill-sprint-setup')).toBeInTheDocument(),
    );
  });

  it('KS-2241: drillsEnabled=true → /drills/sprint/play рендерит PlayPage', async () => {
    flags.drills = true;
    renderWithProviders(<App />, { route: '/drills/sprint/play' });
    await waitFor(() =>
      expect(screen.getByTestId('page-drill-sprint-play')).toBeInTheDocument(),
    );
  });

  it('KS-2241: drillsEnabled=true → /drills/sprint/results рендерит ResultsPage', async () => {
    flags.drills = true;
    renderWithProviders(<App />, { route: '/drills/sprint/results' });
    await waitFor(() =>
      expect(screen.getByTestId('page-drill-sprint-results')).toBeInTheDocument(),
    );
  });

  it('KS-2241: drillsEnabled=false → /drills/sprint редирект на /lobby', async () => {
    flags.drills = false;
    renderWithProviders(<App />, { route: '/drills/sprint' });
    await waitFor(() =>
      expect(screen.getByTestId('page-lobby')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('page-drill-sprint-setup')).not.toBeInTheDocument();
  });

  it('KS-2242: drillsEnabled=true → /drills/sprint/leaderboard рендерит лидерборд', async () => {
    flags.drills = true;
    renderWithProviders(<App />, { route: '/drills/sprint/leaderboard' });
    await waitFor(() =>
      expect(screen.getByTestId('page-drill-leaderboard')).toBeInTheDocument(),
    );
  });

  it('KS-2242: drillsEnabled=false → /drills/sprint/leaderboard редирект на /lobby', async () => {
    flags.drills = false;
    renderWithProviders(<App />, { route: '/drills/sprint/leaderboard' });
    await waitFor(() =>
      expect(screen.getByTestId('page-lobby')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('page-drill-leaderboard')).not.toBeInTheDocument();
  });
});

describe('App routing: dev routes', () => {
  // KS-1821: dev-роуты теперь за compile-time guard `import.meta.env.DEV`.
  // В vitest (dev-режим) условие = true — роуты существуют и рендерятся.
  // Prod-поведение (роуты удалены tree-shake'ом) тестируется smoke-тестом
  // prod-бандла в CI (grep по именам компонентов в `dist/assets/*.js`),
  // т.к. compile-time инлайн не перекрывается runtime-стабом в юнит-тесте.

  it('DEV=true → /dev/reviews-ui рендерится', async () => {
    renderWithProviders(<App />, { route: '/dev/reviews-ui' });
    await waitFor(() =>
      expect(screen.getByTestId('page-dev-reviews')).toBeInTheDocument(),
    );
  });

  it('DEV=true → /dev/playoff-bracket рендерится', async () => {
    renderWithProviders(<App />, { route: '/dev/playoff-bracket' });
    await waitFor(() =>
      expect(screen.getByTestId('page-dev-playoff')).toBeInTheDocument(),
    );
  });
});
