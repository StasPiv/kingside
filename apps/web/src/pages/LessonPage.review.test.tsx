import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';

/**
 * Тесты экрана результата повтора (L-22, KS-1799).
 *
 * Экран отрисовывается после клика «Завершить повтор», который активен
 * только при `score ≥ threshold`. В настоящем UI пройти все шаги
 * возможно, но hideNext у последнего шага убирает кнопку «Далее» — это
 * делает UI-путь хрупким для unit-теста. Вместо этого мокаем
 * `useLessonProgress` на контролируемый стаб, где `score` и
 * `completeLesson(response)` выставляются явно.
 */

const mockLessonsApi = {
  getCourse: vi.fn(),
  getLesson: vi.fn(),
};

vi.mock('../api/lessonsApi', () => ({
  lessonsApi: {
    getCourse: (...a: unknown[]) => mockLessonsApi.getCourse(...a),
    getLesson: (...a: unknown[]) => mockLessonsApi.getLesson(...a),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useParams: () => ({ courseSlug: 'beginner-basics', lessonSlug: 'pieces' }),
  };
});

type CompleteResponse = import('@kingside/shared').CompleteLessonResponse;

// Мок hook'а. Управляем им через `hookConfig` — он обновляется перед
// каждым рендером и возвращается при каждом вызове `useLessonProgress`.
const hookConfig: {
  score: number;
  threshold: number;
  completeLessonResponse: CompleteResponse | null;
  capturedCalls: Array<{ quality?: number }>;
} = {
  score: 0,
  threshold: 0.7,
  completeLessonResponse: null,
  capturedCalls: [],
};

vi.mock('../hooks/useLessonProgress', () => ({
  useLessonProgress: () => ({
    stepsState: {},
    score: hookConfig.score,
    doneCount: 0,
    totalSteps: 1,
    threshold: hookConfig.threshold,
    isCompleting: false,
    lastSyncError: null,
    markStep: vi.fn(),
    resetProgress: vi.fn(),
    completeLesson: async (options?: { quality?: number }) => {
      hookConfig.capturedCalls.push(options ?? {});
      return {
        ok: true,
        ratio: hookConfig.score,
        threshold: hookConfig.threshold,
        progress: hookConfig.completeLessonResponse ?? undefined,
      };
    },
  }),
}));

import { LessonPage } from './LessonPage';

const courseFixture = {
  course: {
    id: 'c1',
    slug: 'beginner-basics',
    level: 'beginner' as const,
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
      kind: 'theory' as const,
      titleI18nKey: 'pieces-title',
      summaryI18nKey: 'pieces-summary',
      stepCount: 1,
      progressState: 'not_started' as const,
      blockKey: 'rules',
    },
  ],
};

const lessonFixture = {
  lesson: {
    id: 'l1',
    courseId: 'c1',
    slug: 'pieces',
    order: 1,
    kind: 'theory' as const,
    titleI18nKey: 'pieces-title',
    summaryI18nKey: 'pieces-summary',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    blockKey: 'rules',
  },
  steps: [
    {
      id: 's1',
      lessonId: 'l1',
      order: 1,
      type: 'text' as const,
      payload: { type: 'text' as const, bodyMarkdown: 'Hello' },
    },
  ],
};

beforeEach(() => {
  mockLessonsApi.getCourse.mockReset();
  mockLessonsApi.getLesson.mockReset();
  hookConfig.score = 0;
  hookConfig.threshold = 0.7;
  hookConfig.completeLessonResponse = null;
  hookConfig.capturedCalls = [];

  mockLessonsApi.getCourse.mockResolvedValue(courseFixture);
  mockLessonsApi.getLesson.mockResolvedValue(lessonFixture);
});

describe('LessonPage review result screen', () => {
  it('≥80% + intervalDays → экран «Освоено, следующий повтор через N дней», quality=5', async () => {
    hookConfig.score = 1.0;
    hookConfig.completeLessonResponse = {
      userId: 'u1',
      lessonId: 'l1',
      startedAt: '2026-04-01T00:00:00.000Z',
      completedAt: '2026-04-24T00:00:00.000Z',
      score: 1,
      stepsState: { s1: 'done' },
      nextDueAt: '2026-05-01T00:00:00.000Z',
      intervalDays: 7,
      easeFactor: 2.6,
    };

    renderWithProviders(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces?mode=review',
    });

    await waitFor(() =>
      expect(screen.getByTestId('lesson-complete-btn')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId('lesson-complete-btn'));

    await waitFor(() =>
      expect(screen.getByTestId('lesson-review-result')).toHaveAttribute(
        'data-outcome',
        'mastered',
      ),
    );

    // score 1.0 ≥ 0.8 → quality=5
    expect(hookConfig.capturedCalls[0]).toEqual({ quality: 5 });

    expect(
      screen.getByTestId('lesson-review-result-explanation-mastered'),
    ).toHaveTextContent(/7/);
    expect(
      screen.getByTestId('lesson-review-result-next-due'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('lesson-review-result-score'),
    ).toHaveTextContent(/1\.00/);
  });

  it('граница 0.8 → всё ещё «Освоено» (mastered)', async () => {
    hookConfig.score = 0.8;
    hookConfig.completeLessonResponse = {
      userId: 'u1',
      lessonId: 'l1',
      startedAt: '2026-04-01T00:00:00.000Z',
      completedAt: '2026-04-24T00:00:00.000Z',
      score: 0.8,
      stepsState: {},
      nextDueAt: '2026-05-01T00:00:00.000Z',
      intervalDays: 3,
    };

    renderWithProviders(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces?mode=review',
    });
    await waitFor(() =>
      expect(screen.getByTestId('lesson-complete-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('lesson-complete-btn'));

    await waitFor(() =>
      expect(screen.getByTestId('lesson-review-result')).toHaveAttribute(
        'data-outcome',
        'mastered',
      ),
    );
    expect(hookConfig.capturedCalls[0]).toEqual({ quality: 5 });
  });

  it('<80% → «Интервал сброшен, повтор завтра», quality=0', async () => {
    hookConfig.score = 0.79;
    hookConfig.threshold = 0; // мокнутый hook игнорирует порог, но для симметрии
    hookConfig.completeLessonResponse = {
      userId: 'u1',
      lessonId: 'l1',
      startedAt: '2026-04-01T00:00:00.000Z',
      completedAt: '2026-04-24T00:00:00.000Z',
      score: 0.79,
      stepsState: {},
      nextDueAt: null,
      intervalDays: 1,
    };

    renderWithProviders(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces?mode=review',
    });
    await waitFor(() =>
      expect(screen.getByTestId('lesson-complete-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('lesson-complete-btn'));

    await waitFor(() =>
      expect(screen.getByTestId('lesson-review-result')).toHaveAttribute(
        'data-outcome',
        'reset',
      ),
    );
    expect(hookConfig.capturedCalls[0]).toEqual({ quality: 0 });
    expect(
      screen.getByTestId('lesson-review-result-explanation-reset'),
    ).toBeInTheDocument();
    // nextDueAt=null → строка «Next review:» не рендерится
    expect(
      screen.queryByTestId('lesson-review-result-next-due'),
    ).not.toBeInTheDocument();
  });

  it('обычный режим (без ?mode=review) — quality не передаётся', async () => {
    hookConfig.score = 1.0;
    hookConfig.completeLessonResponse = {
      userId: 'u1',
      lessonId: 'l1',
      startedAt: '2026-04-01T00:00:00.000Z',
      completedAt: '2026-04-24T00:00:00.000Z',
      score: 1,
      stepsState: {},
    };

    renderWithProviders(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    await waitFor(() =>
      expect(screen.getByTestId('lesson-complete-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('lesson-complete-btn'));

    // KS-2057: после успеха в обычном режиме показывается экран
    // успеха `lesson-completion-overlay`, а не плоский тост.
    await waitFor(() =>
      expect(
        screen.getByTestId('lesson-completion-overlay'),
      ).toBeInTheDocument(),
    );

    // В обычном режиме quality undefined (передаём пустой объект).
    expect(hookConfig.capturedCalls[0]).toEqual({});
    // Экран результата повтора в обычном режиме не рендерится.
    expect(
      screen.queryByTestId('lesson-review-result'),
    ).not.toBeInTheDocument();
  });
});
