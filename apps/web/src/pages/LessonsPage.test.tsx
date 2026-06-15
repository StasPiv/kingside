import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { renderWithProviders, screen, waitFor, testI18n } from '../test/test-utils';
import { LessonsPage } from './LessonsPage';

const mockLessonsApi = {
  listCourses: vi.fn(),
  getReviewsDue: vi.fn(),
};

vi.mock('../api/lessonsApi', () => ({
  lessonsApi: {
    listCourses: (...args: unknown[]) => mockLessonsApi.listCourses(...args),
    getReviewsDue: (...args: unknown[]) => mockLessonsApi.getReviewsDue(...args),
  },
}));

// KS-1940 (F-3): MyCoursesBlock / EnrolledCoursesBlock больше не
// рендерятся на /lessons (активные показывает Hero, созданные — на
// /lessons/my-active в F-4). Их моки удалены — компоненты сюда
// больше не импортируются.

// KS-1922: контекстный hero — собственные тесты в LessonsHero.test.tsx.
vi.mock('../components/lessons/LessonsHero', () => ({
  LessonsHero: () => <div data-testid="lessons-hero-mock" />,
}));

// KS-1940: CreateCourseCta дёргает userCoursesApi.create при клике —
// для тестов LessonsPage это лишний шум. Собственные тесты — в
// `components/lessons/CreateCourseCta.test.tsx`.
vi.mock('../components/lessons/CreateCourseCta', () => ({
  CreateCourseCta: () => <div data-testid="create-course-cta-mock" />,
}));

// KS-2650: AuthContext нужен для табов «Все / Мои» (показываются только
// залогиненным). Тесты LessonsPage не оборачиваются в AuthProvider,
// поэтому мокаем хук `useAuth` сразу — тесты гоняют гостевой режим
// (user=null), таб «Мои» не виден; для проверки таба «Мои» добавили
// отдельные кейсы ниже с переопределённым моком.
const { authMock } = vi.hoisted(() => ({
  authMock: { user: null as { id: string; username: string } | null },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: authMock.user
      ? {
          ...authMock.user,
          email: 'x@x',
          ratingBullet: 1500,
          ratingBlitz: 1500,
          ratingRapid: 1500,
          ratingClassical: 1500,
          createdAt: '2026-01-01',
        }
      : null,
    loading: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// KS-2650: MyCoursesView тянет useAuth + lessonsApi.list — мокаем
// заглушкой, отдельные тесты в `components/lessons/MyCoursesView.test.tsx`.
vi.mock('../components/lessons/views/MyCoursesView', () => ({
  MyCoursesView: () => <div data-testid="my-courses-view-mock" />,
}));

// KS-1923: блоки «New from community» (compact strip) тянут `useAuth` и api —
// для тестов LessonsPage это лишний шум. Собственный тест в
// `components/lessons/CommunityStripBlock.test.tsx`.
vi.mock('../components/lessons/CommunityStripBlock', () => ({
  CommunityStripBlock: () => <div data-testid="community-strip-block-mock" />,
}));

// KS-1944: блок «Рекомендуем вам» тянет `lessonsApi.listCourses` второй раз
// (поверх запроса страницы), что ломает `mockResolvedValueOnce` в тестах
// LessonsPage. Собственные тесты — в `RecommendedCoursesBlock.test.tsx`.
vi.mock('../components/lessons/RecommendedCoursesBlock', () => ({
  RecommendedCoursesBlock: () => (
    <div data-testid="recommended-courses-block-mock" />
  ),
}));

// KS-1924: LazySection использует IntersectionObserver. В happy-dom IO
// отсутствует — без стаба секции остаются в `pending` и нижние блоки
// не рендерятся. Для тестов LessonsPage заменяем LazySection на
// прозрачную обёртку, которая всегда рендерит children. Поведение
// самой LazySection покрыто отдельно в `components/lessons/LazySection.test.tsx`.
vi.mock('../components/lessons/LazySection', () => ({
  LazySection: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

beforeEach(() => {
  mockLessonsApi.listCourses.mockReset();
  mockLessonsApi.getReviewsDue.mockReset();
  // По умолчанию reviews-due пустой — блок «К повторению сегодня» скрыт.
  mockLessonsApi.getReviewsDue.mockResolvedValue({ items: [] });
});

/**
 * KS-1923: loading/empty/error состояния системного списка курсов теперь
 * рендерятся внутри `<CurriculumPillarBlock>` с `data-state`. Для удобства
 * тестов оставляем тот же набор сценариев, но проверяем именно блок.
 */
function pillarState(): string | null {
  const block = screen.queryByTestId('curriculum-pillar-block');
  return block ? block.getAttribute('data-state') : null;
}

describe('LessonsPage', () => {
  it('показывает индикатор загрузки до получения данных', () => {
    mockLessonsApi.listCourses.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<LessonsPage />, { route: '/lessons' });
    expect(pillarState()).toBe('loading');
    expect(
      screen.getByTestId('curriculum-pillar-block').getAttribute('aria-busy'),
    ).toBe('true');
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
    // KS-1943: inline-карточки заменены на <CourseCard> — testid стал
    // `course-card-<slug>-link`.
    expect(
      screen.getByTestId('course-card-beginner-basics-link'),
    ).toHaveAttribute('href', '/lessons/beginner-basics');
    expect(screen.getByTestId('lessons-recommended-badge')).toBeInTheDocument();
    // Бейдж стоит ровно один раз — в beginner-секции.
    const badges = screen.getAllByTestId('lessons-recommended-badge');
    expect(badges).toHaveLength(1);
  });

  it('рендерит сообщение об ошибке при сбое загрузки', async () => {
    mockLessonsApi.listCourses.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<LessonsPage />, { route: '/lessons' });
    await waitFor(() => expect(pillarState()).toBe('error'));
  });

  it('рендерит пустое состояние, если курсов нет', async () => {
    mockLessonsApi.listCourses.mockResolvedValueOnce({ data: [] });
    renderWithProviders(<LessonsPage />, { route: '/lessons' });
    await waitFor(() => expect(pillarState()).toBe('empty'));
  });

  // ─── L-22 (KS-1799) «К повторению сегодня» ───────────────────────────

  it('блок «К повторению сегодня» рендерится с уроками из /reviews/due', async () => {
    // KS-4146: SRS-ревью гостю недоступны (backend требует JWT), поэтому
    // компонент вообще не зовёт `getReviewsDue` если user=null. Тест
    // должен авторизовать пользователя через authMock.
    //
    // KS-4179: `useAuth` мок возвращает каждый раз НОВЫЙ объект `user`
    // (см. vi.mock выше) — useEffect в LessonsPage с зависимостью
    // `[user]` триггерится при каждом ре-рендере и зовёт
    // `getReviewsDue` повторно. После первой mockResolvedValueOnce
    // дальше отрабатывает default (items=[]) и блок скрывается, что
    // вызывало flake. Используем `mockResolvedValue` (без Once), чтобы
    // все повторные вызовы возвращали тот же набор.
    authMock.user = { id: 'u1', username: 'tester' };
    mockLessonsApi.listCourses.mockResolvedValueOnce({ data: [] });
    mockLessonsApi.getReviewsDue.mockResolvedValue({
      items: [
        {
          courseSlug: 'beginner-basics',
          courseTitleI18nKey: 'beginner-basics-title',
          lessonSlug: 'pieces',
          lessonTitleI18nKey: 'pieces-title',
          dueAt: '2026-04-24T00:00:00.000Z',
          lastReviewedAt: '2026-04-17T00:00:00.000Z',
          intervalDays: 7,
        },
        {
          courseSlug: 'beginner-basics',
          courseTitleI18nKey: 'beginner-basics-title',
          lessonSlug: 'rules',
          lessonTitleI18nKey: 'rules-title',
          dueAt: '2026-04-24T00:00:00.000Z',
          lastReviewedAt: null,
          intervalDays: 1,
        },
      ],
    });

    renderWithProviders(<LessonsPage />, { route: '/lessons' });

    await waitFor(() =>
      expect(screen.getByTestId('reviews-due-block')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('reviews-due-count')).toHaveTextContent(/2/);
    // CTA ведёт на /lessons/:courseSlug/:lessonSlug?mode=review
    expect(screen.getByTestId('reviews-due-cta-pieces')).toHaveAttribute(
      'href',
      '/lessons/beginner-basics/pieces?mode=review',
    );
    expect(screen.getByTestId('reviews-due-cta-rules')).toHaveAttribute(
      'href',
      '/lessons/beginner-basics/rules?mode=review',
    );
  });

  it('блок «К повторению сегодня» скрыт, если список пуст', async () => {
    mockLessonsApi.listCourses.mockResolvedValueOnce({ data: [] });
    // getReviewsDue вернёт пустой список (дефолтный mock)
    renderWithProviders(<LessonsPage />, { route: '/lessons' });
    await waitFor(() => expect(pillarState()).toBe('empty'));
    expect(screen.queryByTestId('reviews-due-block')).not.toBeInTheDocument();
  });

  it('блок «К повторению сегодня» скрыт при сетевой ошибке /reviews/due', async () => {
    mockLessonsApi.listCourses.mockResolvedValueOnce({ data: [] });
    mockLessonsApi.getReviewsDue.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<LessonsPage />, { route: '/lessons' });
    await waitFor(() => expect(pillarState()).toBe('empty'));
    expect(screen.queryByTestId('reviews-due-block')).not.toBeInTheDocument();
  });

  // KS-1928 / ADR-032: «Дневник ошибок» переехал в /puzzles namespace.
  // На /lessons блока больше нет — оставляем регрессию на отсутствие.
  it('KS-1928: блок «Дневник ошибок» удалён из /lessons (переехал в /puzzles)', async () => {
    mockLessonsApi.listCourses.mockResolvedValueOnce({ data: [] });
    renderWithProviders(<LessonsPage />, { route: '/lessons' });
    await waitFor(() => expect(pillarState()).toBe('empty'));
    expect(screen.queryByTestId('mistakes-diary-block')).not.toBeInTheDocument();
  });

  // ─── KS-1947 (F-10): регрессии после редизайна ───────────────────────
  // Эти тесты ловят случай «кто-то случайно вернул блок обратно».

  it('KS-1939: LevelGateBanner на /lessons не рендерится', async () => {
    mockLessonsApi.listCourses.mockResolvedValueOnce({ data: [] });
    renderWithProviders(<LessonsPage />, { route: '/lessons' });
    await waitFor(() => expect(pillarState()).toBe('empty'));
    // Дефолтный testid компонента и явные testid'ы со страниц (Lessons + Course).
    expect(screen.queryByTestId('level-gate')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('lessons-page-level-gate'),
    ).not.toBeInTheDocument();
  });

  it('KS-1940: MyCoursesBlock на /lessons не рендерится', async () => {
    mockLessonsApi.listCourses.mockResolvedValueOnce({ data: [] });
    renderWithProviders(<LessonsPage />, { route: '/lessons' });
    await waitFor(() => expect(pillarState()).toBe('empty'));
    expect(screen.queryByTestId('my-courses-block')).not.toBeInTheDocument();
  });

  it('KS-1940: EnrolledCoursesBlock на /lessons не рендерится', async () => {
    mockLessonsApi.listCourses.mockResolvedValueOnce({ data: [] });
    renderWithProviders(<LessonsPage />, { route: '/lessons' });
    await waitFor(() => expect(pillarState()).toBe('empty'));
    expect(
      screen.queryByTestId('enrolled-courses-block'),
    ).not.toBeInTheDocument();
  });

  it('KS-1940: CTA «+ Создать свой курс» доступна (через мок-обёртку)', async () => {
    mockLessonsApi.listCourses.mockResolvedValueOnce({ data: [] });
    renderWithProviders(<LessonsPage />, { route: '/lessons' });
    await waitFor(() => expect(pillarState()).toBe('empty'));
    // CreateCourseCta замокана выше — проверяем что она реально на странице.
    expect(
      screen.getByTestId('create-course-cta-mock'),
    ).toBeInTheDocument();
  });

  // ─── KS-2102: backend читает User.locale, lang в API не передаём ─────

  describe('KS-2102: listCourses без ?lang=', () => {
    it('listCourses вызывается без аргументов', async () => {
      mockLessonsApi.listCourses.mockResolvedValueOnce({ data: [] });
      renderWithProviders(<LessonsPage />, { route: '/lessons' });
      await waitFor(() =>
        expect(mockLessonsApi.listCourses).toHaveBeenCalled(),
      );
      // Никаких аргументов: backend сам резолвит локаль из User.locale.
      for (const call of mockLessonsApi.listCourses.mock.calls) {
        expect(call).toEqual([]);
      }
    });

    it('при смене i18n.language → перезапрос listCourses (тоже без аргументов)', async () => {
      mockLessonsApi.listCourses.mockResolvedValue({ data: [] });
      renderWithProviders(<LessonsPage />, { route: '/lessons' });
      await waitFor(() =>
        expect(mockLessonsApi.listCourses).toHaveBeenCalledTimes(1),
      );

      await act(async () => {
        await testI18n.changeLanguage('ru');
      });

      await waitFor(() =>
        expect(mockLessonsApi.listCourses).toHaveBeenCalledTimes(2),
      );
      // Аргументов по-прежнему нет.
      for (const call of mockLessonsApi.listCourses.mock.calls) {
        expect(call).toEqual([]);
      }

      await act(async () => {
        await testI18n.changeLanguage('en');
      });
    });

    it('пустой data → empty-стейт «Пока нет курсов на вашем языке»', async () => {
      mockLessonsApi.listCourses.mockResolvedValueOnce({ data: [] });
      renderWithProviders(<LessonsPage />, { route: '/lessons' });
      await waitFor(() => expect(pillarState()).toBe('empty'));
      expect(screen.getByTestId('lessons-empty')).toHaveTextContent(
        /No courses are available in your language yet/i,
      );
    });
  });
});
