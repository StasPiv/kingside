import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithAuth, screen, waitFor } from '../test/test-utils-auth';
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
    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    expect(screen.getByTestId('lesson-loading')).toBeInTheDocument();
  });

  // KS-2041: один шаг = один экран. На странице рендерится ровно один
  // активный `<li>`-шаг, а не весь список. Переключение между шагами —
  // через `?step=N` в URL, кнопку «Назад» в nav и «Готово» внутри шага
  // (KS-2056: кнопка «Далее» в nav удалена).
  it('резолвит slug → id урока и рендерит активный шаг (KS-2041)', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    mockLessonsApi.getLesson.mockResolvedValueOnce(lessonFixture);

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });

    await waitFor(() =>
      expect(screen.getByTestId('lesson-page')).toBeInTheDocument(),
    );

    expect(mockLessonsApi.getLesson).toHaveBeenCalledWith('l1');

    const list = screen.getByTestId('lesson-step-list');
    const items = list.querySelectorAll('li');
    // KS-2041: на экране ровно один шаг (активный) — первый по order.
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAttribute('data-testid', 'lesson-step-1');
    expect(items[0]).toHaveTextContent('Theory');
    expect(screen.getByTestId('lesson-text-step')).toBeInTheDocument();
    // Второй шаг (quiz) сейчас не должен быть в DOM.
    expect(screen.queryByTestId('lesson-step-2')).toBeNull();
    expect(screen.queryByTestId('lesson-quiz-step-empty')).toBeNull();
    // KS-1990: кнопка «Далее» внутри text-step — тоже на месте.
    expect(screen.getByTestId('lesson-text-step-next')).toBeInTheDocument();

    // KS-2041: общая навигация шагов снизу.
    expect(screen.getByTestId('lesson-step-nav')).toBeInTheDocument();
    expect(screen.getByTestId('lesson-step-nav-counter').textContent).toBe(
      '1/2',
    );
    expect(screen.getByTestId('lesson-step-nav-prev')).toBeDisabled();
    // KS-2056: кнопки «Далее» больше нет — переход вперёд только
    // через «Готово» внутри шага.
    expect(screen.queryByTestId('lesson-step-nav-next')).toBeNull();

    // Ссылка «назад к курсу» ведёт на /lessons/<slug>
    expect(screen.getByTestId('lesson-back-link')).toHaveAttribute(
      'href',
      '/lessons/beginner-basics',
    );
  });

  it('KS-2056: клик «Готово» внутри шага → переключает на следующий шаг и обновляет ?step', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    mockLessonsApi.getLesson.mockResolvedValueOnce(lessonFixture);

    const { default: userEventLib } = await import(
      '@testing-library/user-event'
    );
    const user = userEventLib.setup();

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    await waitFor(() =>
      expect(screen.getByTestId('lesson-step-1')).toBeInTheDocument(),
    );

    // Кнопка «Далее» в нижней навигации удалена.
    expect(screen.queryByTestId('lesson-step-nav-next')).toBeNull();

    // Переход вперёд — только через «Готово» (lesson-text-step-next)
    // внутри активного text-шага.
    await user.click(screen.getByTestId('lesson-text-step-next'));

    await waitFor(() =>
      expect(screen.getByTestId('lesson-step-2')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('lesson-step-1')).toBeNull();
    expect(screen.getByTestId('lesson-step-nav-counter').textContent).toBe(
      '2/2',
    );
  });

  it('KS-2076: на пройденном (done) шаге в нижней панели появляется «Далее»', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    // s1 уже пройден, s2 — pending. Открываем шаг 1 явно через ?step=1.
    mockLessonsApi.getLesson.mockResolvedValueOnce({
      ...lessonFixture,
      progress: {
        userId: 'u1',
        lessonId: 'l1',
        startedAt: '2026-04-01T00:00:00.000Z',
        completedAt: null,
        score: 0.5,
        stepsState: { s1: 'done' },
      },
    });

    const { default: userEventLib } = await import(
      '@testing-library/user-event'
    );
    const user = userEventLib.setup();

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces?step=1',
    });
    await waitFor(() =>
      expect(screen.getByTestId('lesson-step-1')).toHaveAttribute(
        'data-step-state',
        'done',
      ),
    );

    // Кнопка «Далее» теперь доступна — потому что шаг done и не последний.
    const nextBtn = screen.getByTestId('lesson-step-nav-next');
    expect(nextBtn).toBeInTheDocument();

    // Клик переключает на следующий шаг.
    await user.click(nextBtn);
    await waitFor(() =>
      expect(screen.getByTestId('lesson-step-2')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('lesson-step-1')).toBeNull();
  });

  it('KS-2076: на последнем шаге даже при done кнопки «Далее» нет', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
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

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces?step=2',
    });
    await waitFor(() =>
      expect(screen.getByTestId('lesson-step-2')).toHaveAttribute(
        'data-step-state',
        'done',
      ),
    );
    // Шаг 2 — последний (всего 2 шага). «Далее» не показываем,
    // даже если он done.
    expect(screen.queryByTestId('lesson-step-nav-next')).toBeNull();
    // «Назад» — показывается.
    expect(screen.getByTestId('lesson-step-nav-prev')).toBeInTheDocument();
  });

  it('KS-2078: для уже пройденного урока (completedAt) кнопка «Завершить урок» disabled', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
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

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    const btn = await screen.findByTestId('lesson-complete-btn');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('data-already-completed', 'true');
    expect(btn).toHaveAttribute(
      'title',
      'You have already completed this lesson',
    );
  });

  it('KS-2078: на завершённом уроке клик по disabled-кнопке не вызывает completeLesson', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
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
    const { default: userEventLib } = await import(
      '@testing-library/user-event'
    );
    const user = userEventLib.setup();

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    const btn = await screen.findByTestId('lesson-complete-btn');
    expect(btn).toBeDisabled();
    // user-event эмулирует pointer-события и сам игнорирует disabled-кнопку.
    await user.click(btn);
    expect(mockLessonsApi.completeLesson).not.toHaveBeenCalled();
    // Оверлей завершения тоже не должен появиться повторно.
    expect(screen.queryByTestId('lesson-completion-overlay')).toBeNull();
  });

  it('KS-2078: на непройденном уроке кнопка active без data-already-completed', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    mockLessonsApi.getLesson.mockResolvedValueOnce({
      ...lessonFixture,
      progress: {
        userId: 'u1',
        lessonId: 'l1',
        startedAt: '2026-04-01T00:00:00.000Z',
        completedAt: null,
        score: 1,
        stepsState: { s1: 'done', s2: 'done' },
      },
    });
    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    const btn = await screen.findByTestId('lesson-complete-btn');
    // KS-2078: подождать пока useLessonProgress прокинет initialProgress
    // в локальный score (>=threshold) и canComplete станет true.
    await waitFor(() => expect(btn).not.toBeDisabled());
    expect(btn).not.toHaveAttribute('data-already-completed');
  });

  it('KS-2091: не все шаги done → кнопка disabled с текстом «Complete all steps first»', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    mockLessonsApi.getLesson.mockResolvedValueOnce({
      ...lessonFixture,
      progress: {
        userId: 'u1',
        lessonId: 'l1',
        startedAt: '2026-04-01T00:00:00.000Z',
        completedAt: null,
        // s1 done, s2 ещё нет → не все шаги пройдены.
        score: 0.5,
        stepsState: { s1: 'done' },
      },
    });

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    const btn = await screen.findByTestId('lesson-complete-btn');
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveAttribute('data-all-steps-required', 'true');
    expect(btn).toHaveTextContent('Complete all steps first');
    expect(btn).toHaveAttribute(
      'title',
      'Mark every step as done before completing the lesson',
    );
    expect(btn).not.toHaveAttribute('data-already-completed');
  });

  it('KS-2091: клик по disabled-кнопке (не все шаги done) НЕ зовёт completeLesson', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    mockLessonsApi.getLesson.mockResolvedValueOnce({
      ...lessonFixture,
      progress: {
        userId: 'u1',
        lessonId: 'l1',
        startedAt: '2026-04-01T00:00:00.000Z',
        completedAt: null,
        score: 0.5,
        stepsState: { s1: 'done' },
      },
    });
    const user = (
      await import('@testing-library/user-event')
    ).default.setup();

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    const btn = await screen.findByTestId('lesson-complete-btn');
    await waitFor(() => expect(btn).toBeDisabled());
    await user.click(btn);
    expect(mockLessonsApi.completeLesson).not.toHaveBeenCalled();
    expect(screen.queryByTestId('lesson-completion-overlay')).toBeNull();
  });

  it('KS-2091: все шаги done → кнопка active с «Complete lesson»', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    mockLessonsApi.getLesson.mockResolvedValueOnce({
      ...lessonFixture,
      progress: {
        userId: 'u1',
        lessonId: 'l1',
        startedAt: '2026-04-01T00:00:00.000Z',
        completedAt: null,
        score: 1,
        stepsState: { s1: 'done', s2: 'done' },
      },
    });
    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    const btn = await screen.findByTestId('lesson-complete-btn');
    await waitFor(() => expect(btn).not.toBeDisabled());
    expect(btn).toHaveTextContent('Complete lesson');
    expect(btn).not.toHaveAttribute('data-all-steps-required');
    expect(btn).not.toHaveAttribute('data-already-completed');
  });

  it('KS-2076: на pending-шаге «Далее» отсутствует (KS-2056 поведение)', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    mockLessonsApi.getLesson.mockResolvedValueOnce(lessonFixture);

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces?step=1',
    });
    await waitFor(() =>
      expect(screen.getByTestId('lesson-step-1')).toHaveAttribute(
        'data-step-state',
        'pending',
      ),
    );
    expect(screen.queryByTestId('lesson-step-nav-next')).toBeNull();
  });

  it('KS-2041: ?step=2 в URL открывает второй шаг сразу при mount', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    mockLessonsApi.getLesson.mockResolvedValueOnce(lessonFixture);

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces?step=2',
    });
    await waitFor(() =>
      expect(screen.getByTestId('lesson-step-2')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('lesson-step-1')).toBeNull();
  });

  it('рендерит ошибку «урок не найден», если slug отсутствует в курсе', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce({
      ...courseFixture,
      lessons: [],
    });

    renderWithAuth(<LessonPage />, {
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

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces?mode=review',
    });

    await waitFor(() =>
      expect(screen.getByTestId('lesson-page')).toHaveAttribute('data-mode', 'review'),
    );
    expect(screen.getByTestId('lesson-review-banner')).toBeInTheDocument();

    // KS-2041: на экране активный шаг — в review-режиме всегда первый.
    // stepsState сброшен → шаг pending. Проверяем s1 непосредственно;
    // s2 проверяем через nav, чтобы убедиться что и его state pending.
    const s1 = screen.getByTestId('lesson-step-1');
    expect(s1).toHaveAttribute('data-step-state', 'pending');

    // KS-2056: переход вперёд — через «Готово» внутри text-шага.
    const { default: userEventLib } = await import(
      '@testing-library/user-event'
    );
    const user = userEventLib.setup();
    await user.click(screen.getByTestId('lesson-text-step-next'));
    await waitFor(() =>
      expect(screen.getByTestId('lesson-step-2')).toHaveAttribute(
        'data-step-state',
        'pending',
      ),
    );
  });

  // KS-2041 заменил KS-1986/KS-1992 auto-scroll'ы: теперь не скроллим
  // к нужному шагу, а сразу открываем его как активный (через `?step=N`).
  // Поведение «продолжить с последнего pending» сохранено — но реализовано
  // через переключение URL на mount, а не через scrollIntoView.

  it('KS-2041: <li> активного шага имеет id="step-<step.id>" (anchor сохранён)', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    mockLessonsApi.getLesson.mockResolvedValueOnce(lessonFixture);

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    await waitFor(() =>
      expect(screen.getByTestId('lesson-step-list')).toBeInTheDocument(),
    );
    // На экране активный (первый) шаг — его id присутствует.
    expect(document.getElementById('step-s1')).not.toBeNull();
    // s2 не отрендерен (один шаг = один экран).
    expect(document.getElementById('step-s2')).toBeNull();
  });

  it('KS-2041: при открытии с частичным прогрессом активным становится первый pending-шаг', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    // Первый шаг (s1) — done, второй (s2) — pending. На экране должен
    // сразу появиться s2 (без скролла).
    mockLessonsApi.getLesson.mockResolvedValueOnce({
      ...lessonFixture,
      progress: {
        userId: 'u1',
        lessonId: 'l1',
        startedAt: '2026-04-01T00:00:00.000Z',
        completedAt: null,
        score: 0.5,
        stepsState: { s1: 'done' },
      },
    });

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    await waitFor(() =>
      expect(screen.getByTestId('lesson-step-2')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('lesson-step-1')).toBeNull();
  });

  it('KS-2041: первый шаг pending → активным становится он же', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    mockLessonsApi.getLesson.mockResolvedValueOnce(lessonFixture);

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    await waitFor(() =>
      expect(screen.getByTestId('lesson-step-1')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('lesson-step-2')).toBeNull();
  });

  it('KS-2057: после «Завершить урок» показывается экран успеха с галочкой, заголовком и кнопками', async () => {
    // Курс с двумя уроками — у текущего есть «следующий».
    const courseWithTwo = {
      ...courseFixture,
      lessons: [
        ...courseFixture.lessons,
        {
          id: 'l2',
          slug: 'next-lesson',
          order: 2,
          kind: 'theory',
          titleI18nKey: 'next-lesson-title',
          summaryI18nKey: 'next-lesson-summary',
          stepCount: 1,
          progressState: 'not_started',
        },
      ],
    };
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseWithTwo);
    mockLessonsApi.getLesson.mockResolvedValueOnce({
      ...lessonFixture,
      progress: {
        userId: 'u1',
        lessonId: 'l1',
        startedAt: '2026-04-01T00:00:00.000Z',
        completedAt: null,
        score: 1,
        stepsState: { s1: 'done', s2: 'done' },
      },
    });
    mockLessonsApi.completeLesson.mockResolvedValueOnce({
      userId: 'u1',
      lessonId: 'l1',
      startedAt: '2026-04-01T00:00:00.000Z',
      completedAt: '2026-04-28T00:00:00.000Z',
      score: 1,
      stepsState: { s1: 'done', s2: 'done' },
    });

    const { default: userEventLib } = await import(
      '@testing-library/user-event'
    );
    const user = userEventLib.setup();

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    await waitFor(() =>
      expect(screen.getByTestId('lesson-complete-btn')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('lesson-complete-btn'));

    // Оверлей завершения появился.
    await waitFor(() =>
      expect(
        screen.getByTestId('lesson-completion-overlay'),
      ).toBeInTheDocument(),
    );
    // Заметный визуальный элемент (иконка) и поздравительный заголовок.
    expect(screen.getByTestId('lesson-completion-icon')).toBeInTheDocument();
    expect(screen.getByTestId('lesson-completion-title')).toBeInTheDocument();
    // Конфетти добавлены в DOM (анимация появления длительностью > 0).
    expect(
      screen.getByTestId('lesson-completion-confetti'),
    ).toBeInTheDocument();
    // Кнопка перехода к следующему уроку — есть, ссылка указывает на slug.
    const nextLink = screen.getByTestId('lesson-completion-next');
    expect(nextLink).toHaveAttribute(
      'href',
      '/lessons/beginner-basics/next-lesson',
    );
    // Кнопка возврата к списку уроков курса.
    expect(screen.getByTestId('lesson-completion-to-list')).toHaveAttribute(
      'href',
      '/lessons/beginner-basics',
    );
  });

  it('KS-2057: на последнем уроке курса кнопка «К следующему уроку» не показывается', async () => {
    // Курс с одним уроком — «следующего» нет.
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
    mockLessonsApi.getLesson.mockResolvedValueOnce({
      ...lessonFixture,
      progress: {
        userId: 'u1',
        lessonId: 'l1',
        startedAt: '2026-04-01T00:00:00.000Z',
        completedAt: null,
        score: 1,
        stepsState: { s1: 'done', s2: 'done' },
      },
    });
    mockLessonsApi.completeLesson.mockResolvedValueOnce({
      userId: 'u1',
      lessonId: 'l1',
      startedAt: '2026-04-01T00:00:00.000Z',
      completedAt: '2026-04-28T00:00:00.000Z',
      score: 1,
      stepsState: { s1: 'done', s2: 'done' },
    });

    const { default: userEventLib } = await import(
      '@testing-library/user-event'
    );
    const user = userEventLib.setup();

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    await waitFor(() =>
      expect(screen.getByTestId('lesson-complete-btn')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('lesson-complete-btn'));

    await waitFor(() =>
      expect(
        screen.getByTestId('lesson-completion-overlay'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('lesson-completion-next')).toBeNull();
    expect(
      screen.getByTestId('lesson-completion-to-list'),
    ).toBeInTheDocument();
  });

  it('KS-2041: все шаги done → активным становится первый шаг (не «после конца»)', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce(courseFixture);
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

    renderWithAuth(<LessonPage />, {
      route: '/lessons/beginner-basics/pieces',
    });
    await waitFor(() =>
      expect(screen.getByTestId('lesson-step-1')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('lesson-step-2')).toBeNull();
  });

});
