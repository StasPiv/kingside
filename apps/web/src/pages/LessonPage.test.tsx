import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { LessonPage, reviewScoreToQuality } from './LessonPage';

const mockLessonsApi = {
  getCourse: vi.fn(),
  getLesson: vi.fn(),
  updateStep: vi.fn(),
  completeLesson: vi.fn(),
};

vi.mock('../api/lessonsApi', () => ({
  lessonsApi: {
    getCourse: (...args: unknown[]) => mockLessonsApi.getCourse(...args),
    getLesson: (...args: unknown[]) => mockLessonsApi.getLesson(...args),
    updateStep: (...args: unknown[]) => mockLessonsApi.updateStep(...args),
    completeLesson: (...args: unknown[]) => mockLessonsApi.completeLesson(...args),
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
  mockLessonsApi.updateStep.mockReset();
  mockLessonsApi.completeLesson.mockReset();
  // По умолчанию updateStep/completeLesson успешны.
  mockLessonsApi.updateStep.mockResolvedValue({
    userId: 'u1',
    lessonId: 'l1',
    startedAt: '2026-04-24T00:00:00.000Z',
    completedAt: null,
    score: null,
    stepsState: {},
  });
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

    // Шаг 1 (text) → TextStep, шаг 2 (quiz) → QuizStep (empty-state, т.к. questions=[]).
    expect(screen.getByTestId('lesson-text-step')).toBeInTheDocument();
    expect(screen.getByTestId('lesson-quiz-step-empty')).toBeInTheDocument();
    // KS-1990: кнопка «Далее» теперь и у последнего text-шага тоже —
    // без неё его нечем пометить done без автомаркера.
    expect(screen.getByTestId('lesson-text-step-next')).toBeInTheDocument();

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

  // ─── L-22 (KS-1799): режим review ────────────────────────────────────

  it('reviewScoreToQuality: граница 0.8 → quality=5 («освоено»), <0.8 → quality=0 («сброс»)', () => {
    // Граничные значения
    expect(reviewScoreToQuality(0.8)).toBe(5);
    expect(reviewScoreToQuality(1.0)).toBe(5);
    expect(reviewScoreToQuality(0.79)).toBe(0);
    expect(reviewScoreToQuality(0.0)).toBe(0);
    // Реалистичные значения
    expect(reviewScoreToQuality(0.9)).toBe(5);
    expect(reviewScoreToQuality(0.5)).toBe(0);
  });

  it('?mode=review → отображает баннер «Режим повторения» и не сохраняет серверный progress', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    // Сервер возвращает полный прогресс (оба шага done), но в review-режиме
    // он не должен зазвучать как «всё уже сделано» — пользователь проходит заново.
    mockLessonsApi.getLesson.mockResolvedValueOnce({
      ...lessonFixture,
      progress: {
        userId: 'u1',
        lessonId: 'l1',
        startedAt: '2026-04-01T00:00:00.000Z',
        completedAt: '2026-04-10T00:00:00.000Z',
        score: 1,
        stepsState: { s1: 'done', s2: 'done' },
      },
    });

    renderWithProviders(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces?mode=review',
    });

    await waitFor(() =>
      expect(screen.getByTestId('lesson-page')).toHaveAttribute('data-mode', 'review'),
    );
    expect(screen.getByTestId('lesson-review-banner')).toBeInTheDocument();

    // stepsState сброшен — оба шага в pending, ни одного «done».
    const s1 = screen.getByTestId('lesson-step-1');
    const s2 = screen.getByTestId('lesson-step-2');
    expect(s1).toHaveAttribute('data-step-state', 'pending');
    expect(s2).toHaveAttribute('data-step-state', 'pending');
  });

  // ─── KS-1986: «Далее» скроллит к следующему шагу ────────────────────

  it('KS-1986: клик «Далее» в шаге → scrollIntoView у следующего <li>', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    mockLessonsApi.getLesson.mockResolvedValueOnce(lessonFixture);

    // happy-dom не реализует Element.prototype.scrollIntoView; подменяем
    // на spy, чтобы поймать вызов и проверить аргумент.
    const scrollSpy = vi.fn();
    const proto = window.Element.prototype as unknown as {
      scrollIntoView?: (...args: unknown[]) => void;
    };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = scrollSpy;

    try {
      const { default: userEventLib } = await import(
        '@testing-library/user-event'
      );
      const user = userEventLib.setup();

      renderWithProviders(<LessonPage />, {
        route: '/lessons/beginner-basics/pieces',
      });
      await waitFor(() =>
        expect(screen.getByTestId('lesson-text-step-next')).toBeInTheDocument(),
      );

      // Шаги отрисованы как <li id="step-s1"> / <li id="step-s2"> по
      // фикстуре. Кликаем «Далее» в первом → должен скроллиться #step-s2.
      const next = document.getElementById('step-s2');
      expect(next).not.toBeNull();

      await user.click(screen.getByTestId('lesson-text-step-next'));

      expect(scrollSpy).toHaveBeenCalledTimes(1);
      // `this` для prototype-call'а — element, на котором вызвали метод.
      // Проверяем через mock.contexts (vitest).
      const [args] = scrollSpy.mock.calls[0];
      expect(args).toEqual({ behavior: 'smooth', block: 'start' });
      expect(scrollSpy.mock.contexts[0]).toBe(next);

      // Шаг помечен как done (прогресс пошёл).
      await waitFor(() =>
        expect(screen.getByTestId('lesson-step-1')).toHaveAttribute(
          'data-step-state',
          'done',
        ),
      );
    } finally {
      if (original) {
        proto.scrollIntoView = original;
      } else {
        delete proto.scrollIntoView;
      }
    }
  });

  it('KS-1986: каждый <li> шага имеет id="step-<step.id>" — anchor для scroll', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    mockLessonsApi.getLesson.mockResolvedValueOnce(lessonFixture);

    renderWithProviders(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    await waitFor(() =>
      expect(screen.getByTestId('lesson-step-list')).toBeInTheDocument(),
    );

    expect(document.getElementById('step-s1')).not.toBeNull();
    expect(document.getElementById('step-s2')).not.toBeNull();
  });

});
