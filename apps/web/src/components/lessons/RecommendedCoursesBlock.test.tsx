import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderWithProviders, screen, waitFor } from '../../test/test-utils';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { listCourses: vi.fn() },
}));

vi.mock('../../api/lessonsApi', () => ({
  lessonsApi: apiMock,
}));

import { RecommendedCoursesBlock } from './RecommendedCoursesBlock';

function mkCourse(over: Record<string, unknown> = {}) {
  return {
    id: over.id ?? 'c1',
    slug: over.slug ?? 'c1',
    level: over.level ?? 'intermediate',
    titleI18nKey: over.titleI18nKey ?? 'c1-title',
    descriptionI18nKey: 'c1-desc',
    order: over.order ?? 1,
    lessonCount: over.lessonCount ?? 5,
    progress: over.progress ?? null,
    ...over,
  };
}

beforeEach(() => {
  apiMock.listCourses.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<RecommendedCoursesBlock>', () => {
  it('loading: рисует skeleton (data-state=loading + aria-busy)', () => {
    apiMock.listCourses.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<RecommendedCoursesBlock />);
    const block = screen.getByTestId('recommended-courses-block');
    expect(block.getAttribute('data-state')).toBe('loading');
    expect(block.getAttribute('aria-busy')).toBe('true');
  });

  it('recommendedLevel=null → блок не рендерится', async () => {
    apiMock.listCourses.mockResolvedValueOnce({
      data: [mkCourse({ id: 'a', level: 'intermediate' })],
      recommendedLevel: undefined,
    });
    const { container } = renderWithProviders(<RecommendedCoursesBlock />);
    await waitFor(() => expect(apiMock.listCourses).toHaveBeenCalled());
    // Render должен схлопнуться в null после loading.
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="recommended-courses-block"]'),
      ).toBeNull(),
    );
  });

  it('фильтрует по recommendedLevel и берёт первые 2 по order ASC', async () => {
    apiMock.listCourses.mockResolvedValueOnce({
      data: [
        mkCourse({ id: 'b1', slug: 'b1', level: 'beginner', order: 1 }),
        mkCourse({ id: 'i3', slug: 'i3', level: 'intermediate', order: 3 }),
        mkCourse({ id: 'i1', slug: 'i1', level: 'intermediate', order: 1 }),
        mkCourse({ id: 'i2', slug: 'i2', level: 'intermediate', order: 2 }),
        mkCourse({ id: 'a1', slug: 'a1', level: 'advanced', order: 1 }),
      ],
      recommendedLevel: 'intermediate',
    });
    renderWithProviders(<RecommendedCoursesBlock />);
    await waitFor(() =>
      expect(
        screen.getByTestId('recommended-courses-block').getAttribute('data-state'),
      ).toBe('ready'),
    );
    // Должно быть 2 карточки: i1 и i2 (по order 1, 2). i3 отсечён лимитом.
    expect(screen.getByTestId('course-card-i1')).toBeInTheDocument();
    expect(screen.getByTestId('course-card-i2')).toBeInTheDocument();
    expect(screen.queryByTestId('course-card-i3')).toBeNull();
    // Beginner / advanced — не показываются.
    expect(screen.queryByTestId('course-card-b1')).toBeNull();
    expect(screen.queryByTestId('course-card-a1')).toBeNull();
  });

  it('CTA маппинг: нет прогресса → preview, активный → continue, completed → preview', async () => {
    apiMock.listCourses.mockResolvedValueOnce({
      data: [
        mkCourse({
          id: 'fresh',
          slug: 'fresh',
          level: 'beginner',
          order: 1,
          progress: null,
        }),
        mkCourse({
          id: 'active',
          slug: 'active',
          level: 'beginner',
          order: 2,
          progress: {
            lessonsCompleted: 1,
            startedAt: '2026-04-10T00:00:00Z',
            completedAt: null,
            currentLessonId: null,
          },
        }),
      ],
      recommendedLevel: 'beginner',
    });
    renderWithProviders(<RecommendedCoursesBlock />);
    await waitFor(() =>
      expect(screen.getByTestId('course-card-fresh')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('course-card-fresh').getAttribute('data-cta'),
    ).toBe('preview');
    expect(
      screen.getByTestId('course-card-active').getAttribute('data-cta'),
    ).toBe('continue');
  });

  it('после фильтра нет курсов → блок не рендерится', async () => {
    apiMock.listCourses.mockResolvedValueOnce({
      data: [mkCourse({ level: 'beginner' })],
      recommendedLevel: 'advanced',
    });
    const { container } = renderWithProviders(<RecommendedCoursesBlock />);
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="recommended-courses-block"]'),
      ).toBeNull(),
    );
  });

  it('сетевая ошибка → блок скрывается', async () => {
    apiMock.listCourses.mockRejectedValueOnce(new Error('boom'));
    const { container } = renderWithProviders(<RecommendedCoursesBlock />);
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="recommended-courses-block"]'),
      ).toBeNull(),
    );
  });
});
