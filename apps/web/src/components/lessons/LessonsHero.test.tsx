import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderWithProviders, screen } from '../../test/test-utils';

/**
 * KS-1922: рендер 5 hero-вариантов через мок useLessonsHeroContext.
 */

const { hookMock, authMock } = vi.hoisted(() => ({
  hookMock: { state: { kind: 'loading' } as { kind: string; [k: string]: unknown } },
  authMock: { user: null as { id: string; username: string } | null },
}));

vi.mock('../../hooks/useLessonsHeroContext', () => ({
  useLessonsHeroContext: () => ({ state: hookMock.state }),
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: authMock.user
      ? {
          ...authMock.user,
          email: 'x@x',
          ratingBullet: 1500,
          ratingBlitz: 1500,
          ratingRapid: 1500,
          ratingClassical: 1500,
          createdAt: '2026-01-01',
        }
      : null,
    loading: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { LessonsHero } from './LessonsHero';

beforeEach(() => {
  authMock.user = null;
  hookMock.state = { kind: 'loading' };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<LessonsHero>', () => {
  it('loading: aria-busy + skeleton-shape', () => {
    hookMock.state = { kind: 'loading' };
    renderWithProviders(<LessonsHero />);
    const hero = screen.getByTestId('lessons-hero');
    expect(hero.getAttribute('data-state')).toBe('loading');
    expect(hero.getAttribute('aria-busy')).toBe('true');
  });

  it('continue: title курса + прогресс + CTA → /lessons/my/<slug>', () => {
    hookMock.state = {
      kind: 'continue',
      course: {
        id: 'c1',
        ownerId: 'a1',
        slug: 'caro-kann',
        title: 'Caro-Kann basics',
        description: 'Solid response to e4',
        isPublic: true,
        createdAt: '2026-04-01',
        updatedAt: '2026-04-01',
        lessonCount: 4,
        progress: {
          userCourseId: 'c1',
          completedLessonsCount: 2,
          startedAt: '2026-04-01',
          lastActivityAt: '2026-04-10',
          completedAt: null,
        },
      },
    };
    renderWithProviders(<LessonsHero />);
    const hero = screen.getByTestId('lessons-hero');
    expect(hero.getAttribute('data-state')).toBe('continue');
    expect(hero.textContent).toMatch(/Caro-Kann basics/);
    expect(hero.textContent).toMatch(/2.*4|2\/4/);
    expect(
      screen.getByTestId('lessons-hero-cta').getAttribute('href'),
    ).toBe('/lessons/my/caro-kann');
  });

  it('author: счётчик + CTA «Open editor» → /lessons/my/<slug>/edit', () => {
    hookMock.state = {
      kind: 'author',
      ownedCount: 3,
      publicCount: 2,
      privateCount: 1,
      latestCourse: {
        id: 'c1',
        ownerId: 'me',
        slug: 'my-course',
        title: 'My latest',
        description: null,
        isPublic: true,
        createdAt: '2026-04-01',
        updatedAt: '2026-04-20',
        lessonCount: 3,
      },
    };
    renderWithProviders(<LessonsHero />);
    const hero = screen.getByTestId('lessons-hero');
    expect(hero.getAttribute('data-state')).toBe('author');
    expect(hero.textContent).toMatch(/3/);
    expect(hero.textContent).toMatch(/2.*public|public.*2/i);
    expect(
      screen.getByTestId('lessons-hero-cta').getAttribute('href'),
    ).toBe('/lessons/my/my-course/edit');
  });

  it('author с latestCourse=null → CTA «+ Create new course»', () => {
    hookMock.state = {
      kind: 'author',
      ownedCount: 0,
      publicCount: 0,
      privateCount: 0,
      latestCourse: null,
    };
    renderWithProviders(<LessonsHero />);
    expect(
      screen.getByTestId('lessons-hero-cta').textContent,
    ).toMatch(/create/i);
  });

  it('start: приветствие + CTA на якорь #level-beginner', () => {
    authMock.user = { id: 'u1', username: 'alice' };
    hookMock.state = { kind: 'start' };
    renderWithProviders(<LessonsHero />);
    const hero = screen.getByTestId('lessons-hero');
    expect(hero.getAttribute('data-state')).toBe('start');
    expect(hero.textContent).toMatch(/alice/);
    expect(
      screen.getByTestId('lessons-hero-cta').getAttribute('href'),
    ).toBe('#level-beginner');
  });

  it('guest: 2 CTA (Sign in / Create account) + Browse-link', () => {
    hookMock.state = { kind: 'guest' };
    renderWithProviders(<LessonsHero />);
    const hero = screen.getByTestId('lessons-hero');
    expect(hero.getAttribute('data-state')).toBe('guest');
    expect(
      screen.getByTestId('lessons-hero-cta').getAttribute('href'),
    ).toBe('/login');
    expect(
      screen
        .getByTestId('lessons-hero-cta-secondary')
        .getAttribute('href'),
    ).toBe('/register');
    expect(
      screen.getByTestId('lessons-hero-browse').getAttribute('href'),
    ).toBe('#level-beginner');
  });
});
