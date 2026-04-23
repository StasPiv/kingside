import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { LessonPage } from './LessonPage';

const mockLessonsApi = {
  getCourse: vi.fn(),
  getLesson: vi.fn(),
};

vi.mock('../api/lessonsApi', () => ({
  lessonsApi: {
    getCourse: (...args: unknown[]) => mockLessonsApi.getCourse(...args),
    getLesson: (...args: unknown[]) => mockLessonsApi.getLesson(...args),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useParams: () => ({
      courseSlug: 'beginner-basics',
      lessonSlug: 'pieces',
    }),
  };
});

beforeEach(() => {
  mockLessonsApi.getCourse.mockReset();
  mockLessonsApi.getLesson.mockReset();
});

const courseFixture = {
  course: {
    id: 'c1',
    slug: 'beginner-basics',
    level: 'beginner',
    titleI18nKey: 'beginner-basics-title',
    descriptionI18nKey: 'beginner-basics-desc',
    order: 1,
    isPublished: true,
    lessonCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  lessons: [
    {
      id: 'l1',
      slug: 'pieces',
      order: 1,
      kind: 'theory',
      titleI18nKey: 'pieces-title',
      summaryI18nKey: 'pieces-summary',
      stepCount: 2,
      progressState: 'not_started',
    },
  ],
};

const lessonFixture = {
  lesson: {
    id: 'l1',
    courseId: 'c1',
    slug: 'pieces',
    order: 1,
    kind: 'theory',
    titleI18nKey: 'pieces-title',
    summaryI18nKey: 'pieces-summary',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  steps: [
    {
      id: 's2',
      lessonId: 'l1',
      order: 2,
      type: 'quiz',
      payload: { type: 'quiz', questions: [] },
    },
    {
      id: 's1',
      lessonId: 'l1',
      order: 1,
      type: 'text',
      payload: { type: 'text', bodyMarkdown: '# Hello' },
    },
  ],
};

describe('LessonPage', () => {
  it('показывает индикатор загрузки до получения данных', () => {
    mockLessonsApi.getCourse.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    expect(screen.getByTestId('lesson-loading')).toBeInTheDocument();
  });

  it('резолвит slug → id урока и рендерит контейнер с шагами по order', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    mockLessonsApi.getLesson.mockResolvedValueOnce(lessonFixture);

    renderWithProviders(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });

    await waitFor(() =>
      expect(screen.getByTestId('lesson-page')).toBeInTheDocument(),
    );

    expect(mockLessonsApi.getLesson).toHaveBeenCalledWith('l1');

    const list = screen.getByTestId('lesson-step-list');
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(2);
    // По order=1 первый — text, по order=2 — quiz
    expect(items[0]).toHaveAttribute('data-testid', 'lesson-step-1');
    expect(items[0]).toHaveTextContent('Theory');
    expect(items[1]).toHaveAttribute('data-testid', 'lesson-step-2');
    expect(items[1]).toHaveTextContent('Quiz');

    // Шаг 1 (text) → TextStep, шаг 2 (quiz) → StepRenderer-stub.
    expect(screen.getByTestId('lesson-text-step')).toBeInTheDocument();
    expect(screen.getByTestId('lesson-step-stub-quiz')).toBeInTheDocument();
    // Кнопка «Далее» только у не-последнего шага (text), у последнего (quiz)
    // hideNext=true → нет кнопок «Skip»/«Next».
    expect(screen.getByTestId('lesson-text-step-next')).toBeInTheDocument();
    expect(screen.queryByTestId('lesson-step-stub-next')).toBeNull();

    // Ссылка «назад к курсу» ведёт на /lessons/<slug>
    expect(screen.getByTestId('lesson-back-link')).toHaveAttribute(
      'href',
      '/lessons/beginner-basics',
    );
  });

  it('рендерит ошибку «урок не найден», если slug отсутствует в курсе', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce({
      ...courseFixture,
      lessons: [],
    });

    renderWithProviders(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });

    await waitFor(() =>
      expect(screen.getByTestId('lesson-error')).toBeInTheDocument(),
    );
    expect(mockLessonsApi.getLesson).not.toHaveBeenCalled();
  });
});
