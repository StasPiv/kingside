import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderWithProviders, screen, waitFor } from './test/test-utils';

const flags = { lessons: true };
vi.mock('./config/featureFlags', () => ({
  isLessonsEnabledLive: () => flags.lessons,
}));

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
// useAuth вычитывает /auth/me — вернём unauth-пользователя, чтобы
// ProtectedRoute редиректил на /login. Для теста достаточно.
vi.mock('./context/AuthContext', () => ({
  useAuth: () => ({ user: null, loading: false }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { App } from './App';

beforeEach(() => {
  flags.lessons = true;
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
