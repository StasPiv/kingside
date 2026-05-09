import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  UserCourseDto,
  UserCourseWithLessonsResponse,
  UserLessonDto,
  UserLessonStepDto,
  UserLessonWithStepsResponse,
} from '@kingside/shared';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders, screen, waitFor } from '../test/test-utils';

/**
 * KS-1839 (FE-5): `UserLessonPage`.
 */

const { apiMock, lessonsApiMock } = vi.hoisted(() => ({
  // KS-2645: после слияния `useUserLessonProgress` с `useLessonProgress`
  // прогресс идёт через `lessonsApi.markStep`/`completeLesson`. Course
  // и lesson грузятся через `userCoursesApi.getBySlug/getLesson` —
  // оставлены здесь, потому что UserLessonPage пока ещё ходит через них
  // (полное удаление файла userCoursesApi планируется отдельным коммитом).
  apiMock: {
    getBySlug: vi.fn(),
    getLesson: vi.fn(),
    updateStepProgress: vi.fn(),
    completeLesson: vi.fn(),
  },
  lessonsApiMock: {
    markStep: vi.fn().mockResolvedValue({}),
    completeLesson: vi.fn(),
  },
}));

vi.mock('../api/userCoursesApi', () => ({
  userCoursesApi: apiMock,
}));

vi.mock('../api/lessonsApi', () => ({
  lessonsApi: lessonsApiMock,
}));

// StepRenderer зависит от всех шахматных компонентов — заменяем тонкой
// заглушкой, которая выставляет onStepDone по клику.
vi.mock('../components/lessons/StepRenderer', () => ({
  StepRenderer: ({
    step,
    onStepDone,
  }: {
    step: { id: string };
    onStepDone?: () => void;
  }) => (
    <button
      type="button"
      data-testid={`step-renderer-${step.id}`}
      onClick={() => onStepDone?.()}
    >
      render step
    </button>
  ),
}));

// `useStockfish` в тестах подменяем заглушкой — worker-init в jsdom
// падает; а для контракта FE-8 достаточно проверить, что prefetch
// передан с корректным значением.
const { stockfishMock } = vi.hoisted(() => ({
  stockfishMock: { prefetchArg: null as boolean | null },
}));
vi.mock('../hooks/useStockfish', () => ({
  useStockfish: (opts: { prefetch?: boolean } = {}) => {
    stockfishMock.prefetchArg = opts.prefetch ?? false;
    return {
      state: 'idle' as const,
      lines: [],
      analysisFen: null,
      bestMove: null,
      evaluate: vi.fn(),
      stop: vi.fn(),
      init: vi.fn(),
      cleanup: vi.fn(),
      isReady: true,
    };
  },
}));

import { UserLessonPage } from './UserLessonPage';

function mkCourse(over: Partial<UserCourseDto> = {}): UserCourseDto {
  return {
    id: 'c1',
    ownerId: 'user-1',
    slug: 'my-course',
    title: 'My course',
    description: null,
    isPublic: true,
    createdAt: '2026-04-24T10:00:00Z',
    updatedAt: '2026-04-24T10:00:00Z',
    lessonCount: 2,
    ...over,
  };
}

function mkLesson(over: Partial<UserLessonDto> = {}): UserLessonDto {
  return {
    id: 'l1',
    userCourseId: 'c1',
    order: 0,
    title: 'L1',
    estMinutes: null,
    stepCount: 0,
    ...over,
  };
}

function mkStep(over: Partial<UserLessonStepDto> = {}): UserLessonStepDto {
  return {
    id: 's1',
    userLessonId: 'l1',
    order: 0,
    type: 'text',
    payload: { type: 'text', bodyMarkdown: 'hi', diagrams: [] },
    ...over,
  };
}

function mockCourse(res: UserCourseWithLessonsResponse | 'error') {
  if (res === 'error') apiMock.getBySlug.mockRejectedValue(new Error('404'));
  else apiMock.getBySlug.mockResolvedValue(res);
}

function mockLesson(res: UserLessonWithStepsResponse | 'error') {
  if (res === 'error') apiMock.getLesson.mockRejectedValue(new Error('404'));
  else apiMock.getLesson.mockResolvedValue(res);
}

interface RouterOpts {
  initialPath: string;
  stubNext?: boolean;
  stubCourse?: boolean;
}

function renderRouter({ initialPath, stubNext, stubCourse }: RouterOpts) {
  return renderWithProviders(
    <Routes>
      <Route path="/lessons/my/:slug/:lessonId" element={<UserLessonPage />} />
      {stubNext && (
        <Route
          path="/lessons/my/:slug/:lessonId"
          element={<div data-testid="next-lesson-page" />}
        />
      )}
      {stubCourse && (
        <Route
          path="/lessons/my/:slug"
          element={<div data-testid="course-page" />}
        />
      )}
    </Routes>,
    { route: initialPath },
  );
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  for (const fn of Object.values(lessonsApiMock)) fn.mockReset();
  // markStep по умолчанию резолвится — иначе useLessonProgress
  // выкинет sync-error и тест увидит баннер.
  lessonsApiMock.markStep.mockResolvedValue({});
  stockfishMock.prefetchArg = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<UserLessonPage>', () => {
  it('KS-2629: loading → ready рендерит ТОЛЬКО текущий шаг (?step=1 по умолчанию)', async () => {
    mockCourse({
      course: mkCourse(),
      lessons: [mkLesson({ id: 'l1' })],
      progress: null,
    });
    mockLesson({
      lesson: mkLesson({ id: 'l1', title: 'Lesson One' }),
      steps: [mkStep({ id: 's1' }), mkStep({ id: 's2', order: 1 })],
      progress: null,
    });

    renderRouter({ initialPath: '/lessons/my/my-course/l1' });

    expect(screen.getByTestId('user-lesson-loading')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('user-lesson-page')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('user-lesson-title').textContent).toBe('Lesson One');
    // ADR-053 #1: один шаг = один экран. По умолчанию (без ?step=) —
    // первый pending. Прогресса нет → шаг 1 (s1).
    expect(screen.getByTestId('step-renderer-s1')).toBeInTheDocument();
    expect(screen.queryByTestId('step-renderer-s2')).not.toBeInTheDocument();
  });

  it('KS-2629: ?step=2 → рендерится второй шаг (1-based)', async () => {
    mockCourse({
      course: mkCourse(),
      lessons: [mkLesson({ id: 'l1' })],
      progress: null,
    });
    mockLesson({
      lesson: mkLesson({ id: 'l1' }),
      steps: [mkStep({ id: 's1' }), mkStep({ id: 's2', order: 1 })],
      progress: null,
    });

    renderRouter({ initialPath: '/lessons/my/my-course/l1?step=2' });
    await waitFor(() =>
      expect(screen.getByTestId('user-lesson-page')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('step-renderer-s2')).toBeInTheDocument();
    expect(screen.queryByTestId('step-renderer-s1')).not.toBeInTheDocument();
  });

  it('KS-2629: без ?step= и при наличии серверного прогресса → первый pending', async () => {
    mockCourse({
      course: mkCourse(),
      lessons: [mkLesson({ id: 'l1' })],
      progress: null,
    });
    mockLesson({
      lesson: mkLesson({ id: 'l1' }),
      steps: [
        mkStep({ id: 's1' }),
        mkStep({ id: 's2', order: 1 }),
        mkStep({ id: 's3', order: 2 }),
      ],
      progress: {
        userLessonId: 'l1',
        completedStepsCount: 1,
        totalSteps: 3,
        startedAt: 'x',
        lastActivityAt: 'x',
        completedAt: null,
        // s1 уже done → реадер открывается на s2.
        stepsState: { s1: 'done' },
      },
    });

    renderRouter({ initialPath: '/lessons/my/my-course/l1' });
    await waitFor(() =>
      expect(screen.getByTestId('user-lesson-page')).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByTestId('step-renderer-s2')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('step-renderer-s1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-renderer-s3')).not.toBeInTheDocument();
  });

  it('4xx при загрузке курса → 404', async () => {
    mockCourse('error');
    mockLesson({
      lesson: mkLesson(),
      steps: [],
      progress: null,
    });
    renderRouter({ initialPath: '/lessons/my/my-course/l1' });
    await waitFor(() =>
      expect(screen.getByTestId('user-lesson-404')).toBeInTheDocument(),
    );
  });

  it('Lesson не принадлежит курсу → 404', async () => {
    mockCourse({
      course: mkCourse(),
      // Курс возвращает другие уроки, без l1
      lessons: [mkLesson({ id: 'l-other' })],
      progress: null,
    });
    mockLesson({
      lesson: mkLesson({ id: 'l1' }),
      steps: [mkStep()],
      progress: null,
    });
    renderRouter({ initialPath: '/lessons/my/my-course/l1' });
    await waitFor(() =>
      expect(screen.getByTestId('user-lesson-404')).toBeInTheDocument(),
    );
  });

  /**
   * KS-1892: empty-state для урока без шагов. Студент мог открыть
   * только что добавленный автором урок, у которого ещё нет шагов.
   * Показываем дружелюбный блок и скрываем кнопку «Complete».
   */
  it('KS-1892 — урок без шагов → empty-state + ссылка на курс, без кнопки Complete', async () => {
    mockCourse({
      course: mkCourse({ slug: 'my-course' }),
      lessons: [mkLesson({ id: 'l1' })],
      progress: null,
    });
    mockLesson({
      lesson: mkLesson({ id: 'l1', title: 'Empty lesson' }),
      steps: [],
      progress: null,
    });
    renderRouter({ initialPath: '/lessons/my/my-course/l1' });
    await waitFor(() =>
      expect(screen.getByTestId('user-lesson-page')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('user-lesson-no-steps')).toBeInTheDocument();
    const back = screen.getByTestId('user-lesson-empty-back');
    expect(back).toBeInTheDocument();
    expect(back.getAttribute('href')).toBe('/lessons/my/my-course');
    // Кнопка завершения и прогресс-индикатор скрыты для пустого урока.
    expect(
      screen.queryByTestId('user-lesson-complete-btn'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('user-lesson-progress'),
    ).not.toBeInTheDocument();
    // Шаги не рендерятся, очевидно.
    expect(
      screen.queryByTestId('user-lesson-step-list'),
    ).not.toBeInTheDocument();
  });

  it('KS-1892 — регрессия: непустой урок рендерит шаги и кнопку Complete как раньше', async () => {
    mockCourse({
      course: mkCourse(),
      lessons: [mkLesson({ id: 'l1' })],
      progress: null,
    });
    mockLesson({
      lesson: mkLesson({ id: 'l1' }),
      steps: [mkStep({ id: 's1' })],
      progress: null,
    });
    renderRouter({ initialPath: '/lessons/my/my-course/l1' });
    await waitFor(() =>
      expect(screen.getByTestId('user-lesson-page')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('user-lesson-no-steps')).not.toBeInTheDocument();
    expect(screen.getByTestId('user-lesson-complete-btn')).toBeInTheDocument();
    expect(screen.getByTestId('user-lesson-progress')).toBeInTheDocument();
  });

  it('Complete < threshold → disabled button + сообщение о пороге', async () => {
    mockCourse({
      course: mkCourse({ lessonCount: 1 }),
      lessons: [mkLesson({ id: 'l1' })],
      progress: null,
    });
    mockLesson({
      lesson: mkLesson({ id: 'l1' }),
      // 10 шагов, ни один не помечен → score=0 < threshold
      steps: Array.from({ length: 10 }, (_, i) =>
        mkStep({ id: `s${i}`, order: i }),
      ),
      progress: null,
    });
    renderRouter({ initialPath: '/lessons/my/my-course/l1' });

    await waitFor(() =>
      expect(screen.getByTestId('user-lesson-page')).toBeInTheDocument(),
    );
    const btn = screen.getByTestId('user-lesson-complete-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toMatch(/70%/);
  });

  it('KS-1842: есть endgame_drill → useStockfish получает prefetch=true', async () => {
    mockCourse({
      course: mkCourse({ lessonCount: 1 }),
      lessons: [mkLesson({ id: 'l1' })],
      progress: null,
    });
    mockLesson({
      lesson: mkLesson({ id: 'l1' }),
      steps: [
        mkStep({ id: 's1', type: 'text' }),
        mkStep({
          id: 's2',
          type: 'endgame_drill',
          order: 1,
          payload: {
            type: 'endgame_drill',
            fen: '8/8/8/8/4k3/8/3P4/3K4 w - - 0 1',
            playerSide: 'white',
            skillLevel: 5,
            winCondition: { kind: 'promote' },
          },
        }),
      ],
      progress: null,
    });
    renderRouter({ initialPath: '/lessons/my/my-course/l1' });
    await waitFor(() =>
      expect(screen.getByTestId('user-lesson-page')).toBeInTheDocument(),
    );
    expect(stockfishMock.prefetchArg).toBe(true);
  });

  it('KS-1842: без endgame_drill → useStockfish получает prefetch=false (без регрессии)', async () => {
    mockCourse({
      course: mkCourse({ lessonCount: 1 }),
      lessons: [mkLesson({ id: 'l1' })],
      progress: null,
    });
    mockLesson({
      lesson: mkLesson({ id: 'l1' }),
      steps: [
        mkStep({ id: 's1', type: 'text' }),
        mkStep({
          id: 's2',
          type: 'puzzle',
          order: 1,
          payload: {
            type: 'puzzle',
            selection: { mode: 'ids', puzzleIds: [] },
          },
        }),
      ],
      progress: null,
    });
    renderRouter({ initialPath: '/lessons/my/my-course/l1' });
    await waitFor(() =>
      expect(screen.getByTestId('user-lesson-page')).toBeInTheDocument(),
    );
    expect(stockfishMock.prefetchArg).toBe(false);
  });

  it('Complete ≥ threshold + есть следующий урок → navigate на него', async () => {
    mockCourse({
      course: mkCourse({ lessonCount: 2 }),
      lessons: [
        mkLesson({ id: 'l1', order: 0 }),
        mkLesson({ id: 'l2', order: 1, title: 'Next' }),
      ],
      progress: null,
    });
    mockLesson({
      lesson: mkLesson({ id: 'l1' }),
      steps: [mkStep({ id: 's1' })],
      progress: null,
    });
    // KS-2645: completeLesson теперь идёт через unified `lessonsApi`.
    lessonsApiMock.markStep.mockResolvedValue({});
    lessonsApiMock.completeLesson.mockResolvedValue({
      userCourseId: 'c1',
      completedLessonsCount: 1,
      startedAt: 'x',
      lastActivityAt: 'x',
      completedAt: null,
    });

    // Маршрут /lessons/my/:slug/:lessonId перекрывает и l1, и l2 — для
    // l2 рендерит страницу, но её API-моки ниже не заданы. Для проверки
    // навигации достаточно увидеть, что URL сменился.
    const { container } = renderWithProviders(
      <Routes>
        <Route
          path="/lessons/my/:slug/:lessonId"
          element={<UserLessonPage />}
        />
      </Routes>,
      { route: '/lessons/my/my-course/l1' },
    );
    await waitFor(() =>
      expect(screen.getByTestId('user-lesson-page')).toBeInTheDocument(),
    );

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByTestId('step-renderer-s1'));

    const btn = screen.getByTestId('user-lesson-complete-btn') as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));

    // Перед кликом переопределяем моки — после navigate страница
    // смонтируется заново с новым lessonId, вызовет getLesson('l2').
    apiMock.getLesson.mockReset();
    apiMock.getLesson.mockResolvedValue({
      lesson: mkLesson({ id: 'l2', title: 'Next' }),
      steps: [],
      progress: null,
    });

    fireEvent.click(btn);
    await waitFor(() =>
      expect(lessonsApiMock.completeLesson).toHaveBeenCalledWith(
        'l1',
        expect.objectContaining({ score: 1 }),
      ),
    );
    // После успешного complete — URL сменился на /lessons/my/my-course/l2.
    // Проверяем через getLesson('l2'): если навигация прошла, новый lesson-id
    // будет в параметре вызова.
    await waitFor(() => expect(apiMock.getLesson).toHaveBeenCalledWith('l2'));
    expect(container).toBeTruthy(); // Smoke: страница не упала.
  });

  it('Complete ≥ threshold → POST complete + навигация на курс (если следующий отсутствует)', async () => {
    mockCourse({
      course: mkCourse({ lessonCount: 1 }),
      lessons: [mkLesson({ id: 'l1' })],
      progress: null,
    });
    mockLesson({
      lesson: mkLesson({ id: 'l1' }),
      steps: [mkStep({ id: 's1' })],
      progress: null,
    });
    lessonsApiMock.markStep.mockResolvedValue({});
    lessonsApiMock.completeLesson.mockResolvedValue({
      userCourseId: 'c1',
      completedLessonsCount: 1,
      startedAt: 'x',
      lastActivityAt: 'x',
      completedAt: null,
    });

    renderRouter({
      initialPath: '/lessons/my/my-course/l1',
      stubCourse: true,
    });
    await waitFor(() =>
      expect(screen.getByTestId('user-lesson-page')).toBeInTheDocument(),
    );

    const { fireEvent } = await import('@testing-library/react');
    // «Пройти» шаг (mock StepRenderer → onStepDone).
    fireEvent.click(screen.getByTestId('step-renderer-s1'));

    const btn = screen.getByTestId('user-lesson-complete-btn') as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);

    await waitFor(() =>
      expect(lessonsApiMock.completeLesson).toHaveBeenCalledWith(
        'l1',
        expect.objectContaining({ score: 1 }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('course-page')).toBeInTheDocument(),
    );
  });
});
