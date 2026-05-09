import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, testI18n } from '../test/test-utils';
import { CoursePage } from './CoursePage';
import { ApiError } from '../ApiError';
import { act } from 'react';
import userEvent from '@testing-library/user-event';

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

// KS-2653: после унификации CoursePage тянет `useAuth` (для определения
// owner'а пользовательского курса). Мокаем гостем — все тесты ниже
// рассчитаны на системный курс без owner-блока.
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, loading: false }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

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
    // KS-1991: внешний индекс «N.» убран. Порядок проверяем через
    // последовательность data-testid'ов на ссылках уроков (по order
    // ASC: pieces=1, rules=2).
    expect(items[0].querySelector('a')?.getAttribute('data-testid')).toBe(
      'lesson-link-pieces',
    );
    expect(items[1].querySelector('a')?.getAttribute('data-testid')).toBe(
      'lesson-link-rules',
    );

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

  it('бейджи «Освоено» и «К повторению» (L-22, KS-1799)', async () => {
    const pastDue = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    mockLessonsApi.getCourse.mockResolvedValueOnce({
      course: {
        id: 'c1',
        slug: 'beginner-basics',
        level: 'beginner',
        titleI18nKey: 'beginner-basics-title',
        descriptionI18nKey: 'beginner-basics-desc',
        order: 1,
        isPublished: true,
        lessonCount: 3,
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
          stepCount: 4,
          progressState: 'completed',
          masteredAt: '2026-04-10T00:00:00.000Z',
          dueAt: pastDue,
        },
        {
          id: 'l2',
          slug: 'rules',
          order: 2,
          kind: 'theory',
          titleI18nKey: 'rules-title',
          summaryI18nKey: 'rules-summary',
          stepCount: 3,
          progressState: 'completed',
          masteredAt: '2026-04-12T00:00:00.000Z',
          dueAt: null,
        },
        {
          id: 'l3',
          slug: 'tactics',
          order: 3,
          kind: 'theory',
          titleI18nKey: 'tactics-title',
          summaryI18nKey: 'tactics-summary',
          stepCount: 5,
          progressState: 'not_started',
          masteredAt: null,
          dueAt: null,
        },
      ],
      progress: null,
    });

    renderWithProviders(<CoursePage />, { route: '/lessons/beginner-basics' });

    await waitFor(() =>
      expect(screen.getByTestId('course-page')).toBeInTheDocument(),
    );

    // l1: освоен + повтор сегодня → оба бейджа
    expect(
      screen.getByTestId('course-lesson-mastered-pieces'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('course-lesson-due-pieces'),
    ).toBeInTheDocument();

    // l2: освоен, но не due — только «Освоено»
    expect(
      screen.getByTestId('course-lesson-mastered-rules'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('course-lesson-due-rules'),
    ).not.toBeInTheDocument();

    // l3: ни masteredAt, ни dueAt — без бейджей
    expect(
      screen.queryByTestId('course-lesson-mastered-tactics'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('course-lesson-due-tactics'),
    ).not.toBeInTheDocument();
  });

  it('dueAt в будущем → бейдж «К повторению» не показывается', async () => {
    const futureDue = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    mockLessonsApi.getCourse.mockResolvedValueOnce({
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
          stepCount: 4,
          progressState: 'completed',
          masteredAt: '2026-04-10T00:00:00.000Z',
          dueAt: futureDue,
        },
      ],
      progress: null,
    });

    renderWithProviders(<CoursePage />, { route: '/lessons/beginner-basics' });

    await waitFor(() =>
      expect(screen.getByTestId('course-page')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('course-lesson-mastered-pieces'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('course-lesson-due-pieces'),
    ).not.toBeInTheDocument();
  });

  it('KS-1978: inline title/description курса берутся в приоритет над i18nKey', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce({
      course: {
        id: 'c1',
        slug: 'beginner-01-board-and-notation',
        level: 'beginner',
        // titleI18nKey есть, но в FE-словаре ключа нет — без inline
        // получили бы slug. Inline должен победить.
        titleI18nKey: 'lessons.beginner-01-board-and-notation.title',
        descriptionI18nKey: 'lessons.beginner-01-board-and-notation.description',
        title: 'Доска и нотация',
        description: 'Учимся читать координаты доски и записывать ходы.',
        order: 1,
        isPublished: true,
        lessonCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      lessons: [
        {
          id: 'l1',
          slug: 'board-and-notation',
          order: 1,
          kind: 'theory',
          titleI18nKey: 'lessons.beginner-01-board-and-notation.lesson.title',
          summaryI18nKey: 'lessons.beginner-01-board-and-notation.lesson.summary',
          title: 'Доска и нотация',
          summary: 'Урок о шахматной нотации.',
          stepCount: 5,
          progressState: 'not_started',
        },
      ],
      progress: null,
    });
    renderWithProviders(<CoursePage />, { route: '/lessons/beginner-01-board-and-notation' });
    await waitFor(() =>
      expect(screen.getByTestId('course-page')).toBeInTheDocument(),
    );
    // Заголовок курса не slug.
    expect(
      screen.getByTestId('course-page').querySelector('h1')?.textContent,
    ).toBe('Доска и нотация');
    // Описание из inline.
    expect(
      screen.getByTestId('course-page').querySelector('.course-description')
        ?.textContent,
    ).toBe('Учимся читать координаты доски и записывать ходы.');
    // Заголовок урока — тоже inline.
    const lessonLink = screen.getByTestId('lesson-link-board-and-notation');
    expect(lessonLink.textContent).toContain('Доска и нотация');
  });

  it('KS-1992: completedStepsCount > 0 → «N/M шагов»; =0 → «M шагов»', async () => {
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
          id: 'l1',
          slug: 'pieces',
          order: 1,
          kind: 'theory',
          titleI18nKey: 'pieces-title',
          summaryI18nKey: 'pieces-summary',
          stepCount: 12,
          completedStepsCount: 7,
          progressState: 'in_progress',
        },
        {
          id: 'l2',
          slug: 'rules',
          order: 2,
          kind: 'theory',
          titleI18nKey: 'rules-title',
          summaryI18nKey: 'rules-summary',
          stepCount: 5,
          completedStepsCount: 0,
          progressState: 'not_started',
        },
      ],
      progress: null,
    });
    renderWithProviders(<CoursePage />, { route: '/lessons/beginner-basics' });
    await waitFor(() =>
      expect(screen.getByTestId('course-page')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('course-lesson-step-count-pieces').textContent,
    ).toMatch(/7\s*\/\s*12/);
    // Не начатый — общий счётчик «5 steps» (не «0/5»).
    expect(
      screen.getByTestId('course-lesson-step-count-rules').textContent,
    ).not.toMatch(/0\s*\/\s*5/);
    expect(
      screen.getByTestId('course-lesson-step-count-rules').textContent,
    ).toMatch(/5/);
  });

  describe('KS-2102: getCourse без ?lang= и 404 «недоступен на этом языке»', () => {
    it('getCourse вызывается только со slug — без lang-аргумента', async () => {
      mockLessonsApi.getCourse.mockResolvedValue({
        course: {
          id: 'c1',
          slug: 'beginner-basics',
          level: 'beginner',
          titleI18nKey: 'beginner-basics-title',
          descriptionI18nKey: 'beginner-basics-desc',
          order: 1,
          isPublished: true,
          lessonCount: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        lessons: [],
        progress: null,
      });
      renderWithProviders(<CoursePage />, { route: '/lessons/beginner-basics' });
      await waitFor(() =>
        expect(mockLessonsApi.getCourse).toHaveBeenCalledWith('beginner-basics'),
      );
    });

    it('при 404 — показывает экран «Курс недоступен на этом языке» с кнопкой переключения', async () => {
      mockLessonsApi.getCourse.mockRejectedValueOnce(
        new ApiError('Course not found', 'COURSE_NOT_FOUND', 404),
      );
      renderWithProviders(<CoursePage />, { route: '/lessons/beginner-basics' });
      await waitFor(() =>
        expect(
          screen.getByTestId('course-unavailable-in-lang'),
        ).toBeInTheDocument(),
      );
      // Lang=en → предложить переключиться на ru.
      expect(
        screen.getByTestId('course-unavailable-switch-lang'),
      ).toHaveTextContent(/Переключиться на русский/i);
    });

    it('при не-404 — обычный экран ошибки (фолбэка на ru нет)', async () => {
      mockLessonsApi.getCourse.mockRejectedValueOnce(
        new ApiError('boom', undefined, 500),
      );
      renderWithProviders(<CoursePage />, { route: '/lessons/beginner-basics' });
      await waitFor(() =>
        expect(screen.getByTestId('course-error')).toBeInTheDocument(),
      );
      expect(
        screen.queryByTestId('course-unavailable-in-lang'),
      ).not.toBeInTheDocument();
    });

    it('клик «Переключиться на русский» → i18n.changeLanguage("ru") + getCourse снова (без lang-аргумента)', async () => {
      // Изначально 404 (нет en-версии). После переключения на ru —
      // курс находится. lang-аргумента нет: backend читает
      // User.locale (см. KS-2102).
      mockLessonsApi.getCourse
        .mockRejectedValueOnce(
          new ApiError('not found', 'COURSE_NOT_FOUND', 404),
        )
        .mockResolvedValue({
          course: {
            id: 'c1',
            slug: 'beginner-basics',
            level: 'beginner',
            titleI18nKey: 'beginner-basics-title',
            descriptionI18nKey: 'beginner-basics-desc',
            order: 1,
            isPublished: true,
            lessonCount: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          lessons: [],
          progress: null,
        });

      const user = userEvent.setup();
      renderWithProviders(<CoursePage />, { route: '/lessons/beginner-basics' });
      await waitFor(() =>
        expect(
          screen.getByTestId('course-unavailable-in-lang'),
        ).toBeInTheDocument(),
      );

      await user.click(screen.getByTestId('course-unavailable-switch-lang'));

      await waitFor(() =>
        // Второй вызов getCourse — после смены языка. lang-аргумента
        // не передаём (backend сам резолвит из User.locale).
        expect(mockLessonsApi.getCourse).toHaveBeenLastCalledWith(
          'beginner-basics',
        ),
      );

      // Возврат i18n в 'en' — чтобы соседние тесты не сломались.
      await act(async () => {
        await testI18n.changeLanguage('en');
      });
    });
  });

  it('KS-1978: при отсутствии inline.title — fallback на slug через t(i18nKey)', async () => {
    mockLessonsApi.getCourse.mockResolvedValueOnce({
      course: {
        id: 'c1',
        slug: 'beginner-basics',
        level: 'beginner',
        titleI18nKey: 'beginner-basics-title',
        descriptionI18nKey: 'beginner-basics-desc',
        title: null,
        description: null,
        order: 1,
        isPublished: true,
        lessonCount: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      lessons: [],
      progress: null,
    });
    renderWithProviders(<CoursePage />, { route: '/lessons/beginner-basics' });
    await waitFor(() =>
      expect(screen.getByTestId('course-page')).toBeInTheDocument(),
    );
    // Inline=null → fallback. В test-i18n ключа нет — t() вернёт defaultValue=slug.
    expect(
      screen.getByTestId('course-page').querySelector('h1')?.textContent,
    ).toBe('beginner-basics');
  });
});
