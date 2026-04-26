import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderWithProviders, screen, waitFor } from '../test/test-utils';

const { lessonsApiMock } = vi.hoisted(() => ({
  lessonsApiMock: { listActiveCourses: vi.fn() },
}));

vi.mock('../api/lessonsApi', () => ({ lessonsApi: lessonsApiMock }));

import { MyActiveCoursesPage } from './MyActiveCoursesPage';

function activeSystem(over: Record<string, unknown> = {}) {
  return {
    kind: 'system',
    id: over.id ?? 's1',
    slug: over.slug ?? 's1',
    level: over.level ?? 'beginner',
    titleI18nKey: over.titleI18nKey ?? `${over.slug ?? 's1'}-title`,
    descriptionI18nKey: 'd',
    lessonCount: over.lessonCount ?? 5,
    lessonsCompleted: over.lessonsCompleted ?? 1,
    lastActivityAt: over.lastActivityAt ?? '2026-04-20T00:00:00Z',
    currentLessonSlug: null,
    currentLessonTitleI18nKey: null,
    currentLessonOrder: null,
    coverUrl: null,
    ...over,
  };
}

function activeEnrolled(over: Record<string, unknown> = {}) {
  return {
    kind: 'enrolled',
    id: over.id ?? 'e1',
    slug: over.slug ?? 'e1',
    title: over.title ?? 'Enrolled',
    description: null,
    ownerId: 'o',
    lessonCount: over.lessonCount ?? 4,
    lessonsCompleted: over.lessonsCompleted ?? 1,
    lastActivityAt: over.lastActivityAt ?? '2026-04-22T00:00:00Z',
    currentLessonSlug: null,
    currentLessonTitle: null,
    currentLessonOrder: null,
    ...over,
  };
}

beforeEach(() => {
  lessonsApiMock.listActiveCourses.mockReset();
  lessonsApiMock.listActiveCourses.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<MyActiveCoursesPage>', () => {
  it('loading: aria-busy + skeleton', () => {
    lessonsApiMock.listActiveCourses.mockReturnValue(new Promise(() => {}));
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
    const link = breadcrumb.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/lessons');
    const current = breadcrumb.querySelector('[aria-current="page"]');
    expect(current).not.toBeNull();
  });

  it('сохраняет порядок от backend (sort на бэке, фронт не меняет)', async () => {
    // Имитируем бэк, который уже отсортировал по lastActivityAt DESC.
    lessonsApiMock.listActiveCourses.mockResolvedValueOnce([
      activeSystem({
        id: 'sys-new',
        slug: 'sys-new',
        lastActivityAt: '2026-04-25T00:00:00Z',
      }),
      activeEnrolled({
        id: 'enr-mid',
        slug: 'enr-mid',
        lastActivityAt: '2026-04-22T00:00:00Z',
      }),
      activeSystem({
        id: 'sys-old',
        slug: 'sys-old',
        lastActivityAt: '2026-04-10T00:00:00Z',
      }),
    ]);
    renderWithProviders(<MyActiveCoursesPage />, {
      route: '/lessons/my-active',
    });
    await waitFor(() =>
      expect(screen.getByTestId('my-active-list')).toBeInTheDocument(),
    );
    const items = screen.getByTestId('my-active-list').querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[0].getAttribute('data-testid')).toBe('my-active-item-sys-new');
    expect(items[1].getAttribute('data-testid')).toBe('my-active-item-enr-mid');
    expect(items[2].getAttribute('data-testid')).toBe('my-active-item-sys-old');
  });

  it('бейдж «N дней назад» рендерится ВНУТРИ CourseCard (KS-1956)', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    lessonsApiMock.listActiveCourses.mockResolvedValueOnce([
      activeSystem({ id: 's1', slug: 's1', lastActivityAt: yesterday }),
    ]);
    renderWithProviders(<MyActiveCoursesPage />, {
      route: '/lessons/my-active',
    });
    await waitFor(() =>
      expect(screen.getByTestId('my-active-card-s1')).toBeInTheDocument(),
    );
    const card = screen.getByTestId('my-active-card-s1');
    const recency = card.querySelector('[data-testid="course-card-recency"]');
    expect(recency).not.toBeNull();
    expect(recency?.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it('CourseCard в каждом item: CTA=continue, ссылка на правильный namespace', async () => {
    lessonsApiMock.listActiveCourses.mockResolvedValueOnce([
      activeSystem({ id: 'sys', slug: 'sys', level: 'beginner' }),
      activeEnrolled({ id: 'enr', slug: 'enr' }),
    ]);
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
      screen.getByTestId('my-active-card-sys-link').getAttribute('href'),
    ).toBe('/lessons/sys');
    expect(
      screen.getByTestId('my-active-card-enr-link').getAttribute('href'),
    ).toBe('/lessons/my/enr');
  });

  it('запрос упал → state=error', async () => {
    lessonsApiMock.listActiveCourses.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<MyActiveCoursesPage />, {
      route: '/lessons/my-active',
    });
    await waitFor(() =>
      expect(screen.getByTestId('my-active-error')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('my-active-courses-page').getAttribute('data-state'),
    ).toBe('error');
  });

  it('KS-1957: единственный запрос — listActiveCourses (нет parallel listCourses+listEnrolled)', async () => {
    renderWithProviders(<MyActiveCoursesPage />, {
      route: '/lessons/my-active',
    });
    await waitFor(() =>
      expect(lessonsApiMock.listActiveCourses).toHaveBeenCalledTimes(1),
    );
    // listCourses НЕ должен вызываться — он не в моках, и страница его
    // не импортирует. Если кто-то вернёт обратно — тест увидит вызов
    // несуществующего mock.
  });
});
