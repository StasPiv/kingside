import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderWithProviders, screen, waitFor } from '../test/test-utils';

const { lessonsApiMock, userCoursesApiMock } = vi.hoisted(() => ({
  lessonsApiMock: { listCourses: vi.fn() },
  userCoursesApiMock: { listEnrolled: vi.fn() },
}));

vi.mock('../api/lessonsApi', () => ({ lessonsApi: lessonsApiMock }));
vi.mock('../api/userCoursesApi', () => ({
  userCoursesApi: userCoursesApiMock,
}));

import { MyActiveCoursesPage } from './MyActiveCoursesPage';

function systemActive(over: Record<string, unknown> = {}) {
  return {
    id: over.id ?? 's1',
    slug: over.slug ?? 's1',
    level: over.level ?? 'beginner',
    titleI18nKey: over.titleI18nKey ?? `${over.slug ?? 's1'}-title`,
    descriptionI18nKey: 'd',
    order: 1,
    lessonCount: over.lessonCount ?? 5,
    coverUrl: null,
    progress: {
      lessonsCompleted: 1,
      startedAt: '2026-04-10T00:00:00Z',
      completedAt: null,
      currentLessonId: null,
      lastActivityAt: over.lastActivityAt ?? '2026-04-20T00:00:00Z',
      currentLessonSlug: null,
      currentLessonTitleI18nKey: null,
      currentLessonOrder: null,
    },
    ...over,
  };
}

function enrolledActive(over: Record<string, unknown> = {}) {
  return {
    id: over.id ?? 'e1',
    ownerId: 'o1',
    slug: over.slug ?? 'e1',
    title: over.title ?? 'Enrolled',
    description: null,
    isPublic: true,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    lessonCount: over.lessonCount ?? 4,
    coverUrl: null,
    progress: {
      userCourseId: over.id ?? 'e1',
      completedLessonsCount: 1,
      startedAt: '2026-04-01T00:00:00Z',
      lastActivityAt: over.lastActivityAt ?? '2026-04-22T00:00:00Z',
      completedAt: null,
      currentLessonSlug: null,
      currentLessonTitle: null,
      currentLessonOrder: null,
    },
    ...over,
  };
}

beforeEach(() => {
  lessonsApiMock.listCourses.mockReset();
  userCoursesApiMock.listEnrolled.mockReset();
  // По умолчанию пустые ответы.
  lessonsApiMock.listCourses.mockResolvedValue({ data: [] });
  userCoursesApiMock.listEnrolled.mockResolvedValue({ data: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<MyActiveCoursesPage>', () => {
  it('loading: aria-busy + skeleton', () => {
    lessonsApiMock.listCourses.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<MyActiveCoursesPage />, {
      route: '/lessons/my-active',
    });
    const page = screen.getByTestId('my-active-courses-page');
    expect(page.getAttribute('data-state')).toBe('loading');
    const skeleton = screen.getByTestId('my-active-skeleton');
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
  });

  it('empty: после загрузки нет активных → empty-state с CTA', async () => {
    renderWithProviders(<MyActiveCoursesPage />, {
      route: '/lessons/my-active',
    });
    await waitFor(() =>
      expect(screen.getByTestId('my-active-empty')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('my-active-empty-cta').getAttribute('href'),
    ).toBe('/lessons');
  });

  it('breadcrumb: «Уроки / Мои активные курсы»', async () => {
    renderWithProviders(<MyActiveCoursesPage />, {
      route: '/lessons/my-active',
    });
    const breadcrumb = screen.getByTestId('my-active-breadcrumb');
    // Ссылка на /lessons.
    const link = breadcrumb.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/lessons');
    // aria-current="page" на текущей.
    const current = breadcrumb.querySelector('[aria-current="page"]');
    expect(current).not.toBeNull();
  });

  it('mix system + enrolled, сортирует по lastActivityAt DESC', async () => {
    lessonsApiMock.listCourses.mockResolvedValueOnce({
      data: [
        systemActive({
          id: 'sys-old',
          slug: 'sys-old',
          lastActivityAt: '2026-04-10T00:00:00Z',
        }),
        systemActive({
          id: 'sys-new',
          slug: 'sys-new',
          lastActivityAt: '2026-04-25T00:00:00Z',
        }),
      ],
    });
    userCoursesApiMock.listEnrolled.mockResolvedValueOnce({
      data: [
        enrolledActive({
          id: 'enr-mid',
          slug: 'enr-mid',
          lastActivityAt: '2026-04-20T00:00:00Z',
        }),
      ],
    });
    renderWithProviders(<MyActiveCoursesPage />, {
      route: '/lessons/my-active',
    });
    await waitFor(() =>
      expect(screen.getByTestId('my-active-list')).toBeInTheDocument(),
    );
    const items = screen
      .getByTestId('my-active-list')
      .querySelectorAll('li');
    expect(items).toHaveLength(3);
    // Порядок: sys-new (25), enr-mid (20), sys-old (10).
    expect(items[0].getAttribute('data-testid')).toBe(
      'my-active-item-sys-new',
    );
    expect(items[1].getAttribute('data-testid')).toBe(
      'my-active-item-enr-mid',
    );
    expect(items[2].getAttribute('data-testid')).toBe(
      'my-active-item-sys-old',
    );
  });

  it('фильтрует завершённые (completedAt != null)', async () => {
    lessonsApiMock.listCourses.mockResolvedValueOnce({
      data: [
        systemActive({ id: 'sys-active', slug: 'sys-active' }),
        // completed — должен отсеяться
        {
          ...systemActive({ id: 'sys-done', slug: 'sys-done' }),
          progress: {
            lessonsCompleted: 5,
            startedAt: '2026-04-01T00:00:00Z',
            completedAt: '2026-04-15T00:00:00Z',
            currentLessonId: null,
            lastActivityAt: '2026-04-15T00:00:00Z',
            currentLessonSlug: null,
            currentLessonTitleI18nKey: null,
            currentLessonOrder: null,
          },
        },
      ],
    });
    renderWithProviders(<MyActiveCoursesPage />, {
      route: '/lessons/my-active',
    });
    await waitFor(() =>
      expect(screen.getByTestId('my-active-list')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('my-active-item-sys-active'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('my-active-item-sys-done')).toBeNull();
  });

  it('бейдж «N дней назад» рендерится ВНУТРИ CourseCard (KS-1956)', async () => {
    // Используем «вчерашнюю» активность относительно реального now —
    // тест защищён от fake-timers, чтобы не ломать Promise scheduling.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    lessonsApiMock.listCourses.mockResolvedValueOnce({
      data: [
        systemActive({ id: 's1', slug: 's1', lastActivityAt: yesterday }),
      ],
    });
    renderWithProviders(<MyActiveCoursesPage />, {
      route: '/lessons/my-active',
    });
    await waitFor(() =>
      expect(screen.getByTestId('my-active-card-s1')).toBeInTheDocument(),
    );
    // KS-1956: recency-бейдж теперь часть CourseCard, не отдельный
    // элемент под карточкой. Старый testid `my-active-relative-<slug>`
    // удалён, бейдж ищем по `course-card-recency` ВНУТРИ карточки.
    const card = screen.getByTestId('my-active-card-s1');
    const recency = card.querySelector('[data-testid="course-card-recency"]');
    expect(recency).not.toBeNull();
    expect(recency?.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it('CourseCard в каждом item: CTA=continue, ссылка на правильный namespace', async () => {
    lessonsApiMock.listCourses.mockResolvedValueOnce({
      data: [systemActive({ id: 'sys', slug: 'sys', level: 'beginner' })],
    });
    userCoursesApiMock.listEnrolled.mockResolvedValueOnce({
      data: [enrolledActive({ id: 'enr', slug: 'enr' })],
    });
    renderWithProviders(<MyActiveCoursesPage />, {
      route: '/lessons/my-active',
    });
    await waitFor(() =>
      expect(screen.getByTestId('my-active-list')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('my-active-card-sys').getAttribute('data-cta'),
    ).toBe('continue');
    expect(
      screen
        .getByTestId('my-active-card-sys-link')
        .getAttribute('href'),
    ).toBe('/lessons/sys');
    expect(
      screen
        .getByTestId('my-active-card-enr-link')
        .getAttribute('href'),
    ).toBe('/lessons/my/enr');
  });

  it('оба запроса упали → state=error', async () => {
    lessonsApiMock.listCourses.mockRejectedValueOnce(new Error('boom'));
    userCoursesApiMock.listEnrolled.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<MyActiveCoursesPage />, {
      route: '/lessons/my-active',
    });
    await waitFor(() =>
      expect(screen.getByTestId('my-active-error')).toBeInTheDocument(),
    );
    expect(
      screen
        .getByTestId('my-active-courses-page')
        .getAttribute('data-state'),
    ).toBe('error');
  });

  it('один запрос упал — graceful: рендерим что есть', async () => {
    lessonsApiMock.listCourses.mockResolvedValueOnce({
      data: [systemActive({ id: 's1', slug: 's1' })],
    });
    userCoursesApiMock.listEnrolled.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<MyActiveCoursesPage />, {
      route: '/lessons/my-active',
    });
    await waitFor(() =>
      expect(screen.getByTestId('my-active-item-s1')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('my-active-error')).toBeNull();
  });
});
