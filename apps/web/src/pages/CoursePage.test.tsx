import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { CoursePage } from './CoursePage';

const mockLessonsApi = {
  getCourse: vi.fn(),
};

vi.mock('../api/lessonsApi', () => ({
  lessonsApi: {
    getCourse: (...args: unknown[]) => mockLessonsApi.getCourse(...args),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useParams: () => ({ courseSlug: 'beginner-basics' }),
  };
});

beforeEach(() => {
  mockLessonsApi.getCourse.mockReset();
});

describe('CoursePage', () => {
  it('показывает индикатор загрузки до получения данных', () => {
    mockLessonsApi.getCourse.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<CoursePage />, { route: '/lessons/beginner-basics' });
    expect(screen.getByTestId('course-loading')).toBeInTheDocument();
  });

  it('рендерит курс, прогресс и список уроков, отсортированный по order', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce({
      course: {
        id: 'c1',
        slug: 'beginner-basics',
        level: 'beginner',
        titleI18nKey: 'beginner-basics-title',
        descriptionI18nKey: 'beginner-basics-desc',
        order: 1,
        isPublished: true,
        lessonCount: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      lessons: [
        {
          id: 'l2',
          slug: 'rules',
          order: 2,
          kind: 'theory',
          titleI18nKey: 'rules-title',
          summaryI18nKey: 'rules-summary',
          stepCount: 3,
          progressState: 'not_started',
        },
        {
          id: 'l1',
          slug: 'pieces',
          order: 1,
          kind: 'theory',
          titleI18nKey: 'pieces-title',
          summaryI18nKey: 'pieces-summary',
          stepCount: 4,
          progressState: 'completed',
        },
      ],
      progress: {
        userId: 'u1',
        courseId: 'c1',
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: null,
        currentLessonId: 'l2',
        lessonsCompleted: 1,
        lessonsTotal: 2,
      },
    });

    renderWithProviders(<CoursePage />, { route: '/lessons/beginner-basics' });

    await waitFor(() =>
      expect(screen.getByTestId('course-page')).toBeInTheDocument(),
    );

    const list = screen.getByTestId('course-lesson-list');
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(2);
    // Первый элемент — order=1, второй — order=2
    expect(items[0]).toHaveTextContent('1.');
    expect(items[1]).toHaveTextContent('2.');

    expect(screen.getByTestId('lesson-link-pieces')).toHaveAttribute(
      'href',
      '/lessons/beginner-basics/pieces',
    );
    expect(screen.getByTestId('lesson-link-rules')).toHaveAttribute(
      'href',
      '/lessons/beginner-basics/rules',
    );

    // Прогресс 1/2 → 50%
    const fill = screen.getByTestId('course-progress-fill');
    expect(fill).toHaveStyle({ width: '50%' });
  });

  it('рендерит ошибку при сбое загрузки', async () => {
    mockLessonsApi.getCourse.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<CoursePage />, { route: '/lessons/beginner-basics' });
    await waitFor(() =>
      expect(screen.getByTestId('course-error')).toBeInTheDocument(),
    );
  });
});
