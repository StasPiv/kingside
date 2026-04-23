import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { LessonsPage } from './LessonsPage';

const mockLessonsApi = {
  listCourses: vi.fn(),
  getLevelGate: vi.fn(),
};

vi.mock('../api/lessonsApi', () => ({
  lessonsApi: {
    listCourses: (...args: unknown[]) => mockLessonsApi.listCourses(...args),
    getLevelGate: (...args: unknown[]) => mockLessonsApi.getLevelGate(...args),
  },
}));

beforeEach(() => {
  mockLessonsApi.listCourses.mockReset();
  mockLessonsApi.getLevelGate.mockReset();
  // По умолчанию level-gate скрыт — никаких блокеров и nextLevel.
  mockLessonsApi.getLevelGate.mockResolvedValue({
    currentLevel: 'advanced',
    nextLevel: null,
    unlocked: false,
    blockers: [],
  });
});

describe('LessonsPage', () => {
  it('показывает индикатор загрузки до получения данных', () => {
    mockLessonsApi.listCourses.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<LessonsPage />, { route: '/lessons' });
    expect(screen.getByTestId('lessons-loading')).toBeInTheDocument();
  });

  it('рендерит курсы, сгруппированные по уровню, и бейдж рекомендации', async () => {
    mockLessonsApi.listCourses.mockResolvedValueOnce({
      data: [
        {
          id: 'c1',
          slug: 'beginner-basics',
          level: 'beginner',
          titleI18nKey: 'beginner-basics-title',
          descriptionI18nKey: 'beginner-basics-desc',
          order: 1,
          lessonCount: 5,
        },
        {
          id: 'c2',
          slug: 'intermediate-tactics',
          level: 'intermediate',
          titleI18nKey: 'intermediate-tactics-title',
          descriptionI18nKey: 'intermediate-tactics-desc',
          order: 1,
          lessonCount: 8,
        },
      ],
      recommendedLevel: 'beginner',
    });

    renderWithProviders(<LessonsPage />, { route: '/lessons' });

    await waitFor(() =>
      expect(screen.getByTestId('lessons-page')).toBeInTheDocument(),
    );

    expect(screen.getByTestId('lessons-level-beginner')).toBeInTheDocument();
    expect(screen.getByTestId('lessons-level-intermediate')).toBeInTheDocument();
    expect(screen.getByTestId('course-link-beginner-basics')).toHaveAttribute(
      'href',
      '/lessons/beginner-basics',
    );
    expect(screen.getByTestId('lessons-recommended-badge')).toBeInTheDocument();
    // Бейдж стоит ровно один раз — в beginner-секции.
    const badges = screen.getAllByTestId('lessons-recommended-badge');
    expect(badges).toHaveLength(1);
  });

  it('рендерит сообщение об ошибке при сбое загрузки', async () => {
    mockLessonsApi.listCourses.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<LessonsPage />, { route: '/lessons' });
    await waitFor(() =>
      expect(screen.getByTestId('lessons-error')).toBeInTheDocument(),
    );
  });

  it('рендерит пустое состояние, если курсов нет', async () => {
    mockLessonsApi.listCourses.mockResolvedValueOnce({ data: [] });
    renderWithProviders(<LessonsPage />, { route: '/lessons' });
    await waitFor(() =>
      expect(screen.getByTestId('lessons-empty')).toBeInTheDocument(),
    );
  });
});
