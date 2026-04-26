import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderWithProviders, screen } from '../../test/test-utils';

/**
 * KS-1922 + KS-1938: рендер 6 hero-вариантов через мок useLessonsHeroContext.
 *
 * loading / continue / multi / author / start / guest.
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
  it('loading: aria-busy + skeleton', () => {
    hookMock.state = { kind: 'loading' };
    renderWithProviders(<LessonsHero />);
    const hero = screen.getByTestId('lessons-hero');
    expect(hero.getAttribute('data-state')).toBe('loading');
    expect(hero.getAttribute('aria-busy')).toBe('true');
  });

  // ─── continue ───

  it('continue (enrolled): title + прогресс + CTA → /lessons/my/<slug>', () => {
    hookMock.state = {
      kind: 'continue',
      course: {
        source: 'enrolled',
        id: 'e1',
        slug: 'caro-kann',
        title: 'Caro-Kann basics',
        titleI18nKey: null,
        level: null,
        coverUrl: null,
        lessonCount: 4,
        completedLessons: 2,
        lastActivityAt: '2026-04-10',
        currentLessonSlug: null,
        currentLessonTitleI18nKey: null,
        currentLessonTitle: null,
        currentLessonOrder: null,
        href: '/lessons/my/caro-kann',
      },
    };
    renderWithProviders(<LessonsHero />);
    const hero = screen.getByTestId('lessons-hero');
    expect(hero.getAttribute('data-state')).toBe('continue');
    expect(hero.getAttribute('data-source')).toBe('enrolled');
    expect(hero.textContent).toMatch(/Caro-Kann basics/);
    expect(hero.textContent).toMatch(/2.*4|2\/4/);
    expect(
      screen.getByTestId('lessons-hero-cta').getAttribute('href'),
    ).toBe('/lessons/my/caro-kann');
  });

  it('continue (system): href=/lessons/<slug> и cover-placeholder с фигурой по уровню', () => {
    hookMock.state = {
      kind: 'continue',
      course: {
        source: 'system',
        id: 's1',
        slug: 'beginner-basics',
        title: '',
        titleI18nKey: 'beginner-basics-title',
        level: 'beginner',
        coverUrl: null, // → placeholder
        lessonCount: 8,
        completedLessons: 3,
        lastActivityAt: '2026-04-10',
        currentLessonSlug: null,
        currentLessonTitleI18nKey: null,
        currentLessonTitle: null,
        currentLessonOrder: null,
        href: '/lessons/beginner-basics',
      },
    };
    renderWithProviders(<LessonsHero />);
    expect(
      screen.getByTestId('lessons-hero-cta').getAttribute('href'),
    ).toBe('/lessons/beginner-basics');
    const cover = screen.getByTestId('lessons-hero-cover');
    expect(cover.getAttribute('data-source')).toBe('system');
    expect(cover.getAttribute('data-level')).toBe('beginner');
    // Фигура пешки для beginner.
    expect(cover.textContent).toContain('♟');
  });

  it('continue: при coverUrl рендерит <img>', () => {
    hookMock.state = {
      kind: 'continue',
      course: {
        source: 'enrolled',
        id: 'e1',
        slug: 'x',
        title: 'X',
        titleI18nKey: null,
        level: null,
        coverUrl: 'https://cdn/x.jpg',
        lessonCount: 4,
        completedLessons: 1,
        lastActivityAt: '2026-04-10',
        currentLessonSlug: null,
        currentLessonTitleI18nKey: null,
        currentLessonTitle: null,
        currentLessonOrder: null,
        href: '/lessons/my/x',
      },
    };
    renderWithProviders(<LessonsHero />);
    const cover = screen.getByTestId('lessons-hero-cover');
    const img = cover.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://cdn/x.jpg');
  });

  // ─── KS-1955 / KS-1938 §7.2: «Урок N из M — название» + «N дней назад» ───

  it('continue (system): рендерит «Урок N из M — <title>» (через i18n) и «Last activity»', () => {
    // Фиксируем «сейчас» = 2026-04-26, lastActivityAt = 2026-04-23 → 3 дня.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-26T12:00:00Z'));
    hookMock.state = {
      kind: 'continue',
      course: {
        source: 'system',
        id: 's1',
        slug: 'beginner-basics',
        title: '',
        titleI18nKey: 'beginner-basics-title',
        level: 'beginner',
        coverUrl: null,
        lessonCount: 8,
        completedLessons: 4,
        lastActivityAt: '2026-04-23T12:00:00Z',
        currentLessonSlug: 'king-pawn',
        currentLessonTitleI18nKey: 'king-pawn-title',
        currentLessonTitle: null,
        currentLessonOrder: 5,
        href: '/lessons/beginner-basics',
      },
    };
    renderWithProviders(<LessonsHero />);
    const lessonOf = screen.getByTestId('lessons-hero-lesson-of');
    // Title через i18n — fallback на ключ (king-pawn-title в нашем словаре нет).
    expect(lessonOf.textContent).toMatch(/5/);
    expect(lessonOf.textContent).toMatch(/8/);
    // 3 days
    const lastActivity = screen.getByTestId('lessons-hero-last-activity');
    expect(lastActivity.textContent).toMatch(/3/);
    vi.useRealTimers();
  });

  it('continue (enrolled): «Урок N из M — <title>» из currentLessonTitle (raw)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-26T12:00:00Z'));
    hookMock.state = {
      kind: 'continue',
      course: {
        source: 'enrolled',
        id: 'e1',
        slug: 'caro-kann',
        title: 'Caro-Kann',
        titleI18nKey: null,
        level: null,
        coverUrl: null,
        lessonCount: 4,
        completedLessons: 2,
        lastActivityAt: '2026-04-26T11:30:00Z', // 30 минут назад → less than hour
        currentLessonSlug: 'main-line',
        currentLessonTitleI18nKey: null,
        currentLessonTitle: 'Главный вариант',
        currentLessonOrder: 3,
        href: '/lessons/my/caro-kann',
      },
    };
    renderWithProviders(<LessonsHero />);
    expect(
      screen.getByTestId('lessons-hero-lesson-of').textContent,
    ).toContain('Главный вариант');
    expect(
      screen.getByTestId('lessons-hero-lesson-of').textContent,
    ).toMatch(/3/);
    expect(
      screen.getByTestId('lessons-hero-last-activity').textContent.toLowerCase(),
    ).toMatch(/less|меньше/);
    vi.useRealTimers();
  });

  it('continue: без currentLessonOrder/title — строка «Урок N из M» не рендерится', () => {
    hookMock.state = {
      kind: 'continue',
      course: {
        source: 'system',
        id: 's1',
        slug: 'b',
        title: '',
        titleI18nKey: 'b-title',
        level: 'beginner',
        coverUrl: null,
        lessonCount: 5,
        completedLessons: 2,
        lastActivityAt: '2026-04-26T12:00:00Z',
        currentLessonSlug: null,
        currentLessonTitleI18nKey: null,
        currentLessonTitle: null,
        currentLessonOrder: null,
        href: '/lessons/b',
      },
    };
    renderWithProviders(<LessonsHero />);
    expect(screen.queryByTestId('lessons-hero-lesson-of')).toBeNull();
  });

  // ─── multi ───

  it('multi: count + ссылка на /lessons/my-active', () => {
    hookMock.state = { kind: 'multi', count: 3 };
    renderWithProviders(<LessonsHero />);
    const hero = screen.getByTestId('lessons-hero');
    expect(hero.getAttribute('data-state')).toBe('multi');
    expect(
      screen.getByTestId('lessons-hero-multi-title').textContent,
    ).toMatch(/3/);
    expect(
      screen.getByTestId('lessons-hero-cta').getAttribute('href'),
    ).toBe('/lessons/my-active');
  });

  // ─── author ───

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

  // ─── start ───

  it('start с beginnerSlug: CTA → /lessons/<slug>', () => {
    authMock.user = { id: 'u1', username: 'alice' };
    hookMock.state = {
      kind: 'start',
      beginnerSlug: 'beginner-basics',
      beginnerTitleI18nKey: 'beginner-basics-title',
    };
    renderWithProviders(<LessonsHero />);
    const hero = screen.getByTestId('lessons-hero');
    expect(hero.getAttribute('data-state')).toBe('start');
    expect(hero.textContent).toMatch(/alice/);
    expect(
      screen.getByTestId('lessons-hero-cta').getAttribute('href'),
    ).toBe('/lessons/beginner-basics');
  });

  it('start без beginnerSlug: fallback CTA на якорь #level-beginner', () => {
    authMock.user = { id: 'u1', username: 'bob' };
    hookMock.state = {
      kind: 'start',
      beginnerSlug: null,
      beginnerTitleI18nKey: null,
    };
    renderWithProviders(<LessonsHero />);
    expect(
      screen.getByTestId('lessons-hero-cta').getAttribute('href'),
    ).toBe('#level-beginner');
  });

  // ─── guest ───

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
