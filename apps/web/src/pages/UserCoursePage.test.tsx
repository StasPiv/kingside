import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  UserCourseDto,
  UserCourseWithLessonsResponse,
  UserLessonDto,
  UserCoursePlayProgressDto,
} from '@kingside/shared';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders, screen, waitFor } from '../test/test-utils';

/**
 * KS-1838 (FE-4): `UserCoursePage`.
 *
 * Покрытие:
 *  - loader → ready с уроками и прогрессом
 *  - 4xx (404 / 403 для приватного чужого) → общий экран 404
 *  - Owner-actions видны только владельцу (user.id === course.ownerId)
 *  - Не-owner публичного курса: только «Open»-ссылка на урок, без actions
 *  - Toggle visibility → userCoursesApi.update({isPublic})
 *  - Delete → confirm → userCoursesApi.delete + редирект на /lessons
 *  - Ссылка «Open» на урок ведёт на `/lessons/my/:slug/:lessonId`
 */

// KS-2645: UserCoursePage переключён на `lessonsApi`. Чтобы не переписывать
// все ссылки в тесте, `apiMock` стал тонким алиасом на единый mock'ed
// `lessonsApi` (имена методов мапятся: `getBySlug` → `getUserCourse`,
// `update` → `updateCourse`, `delete` → `deleteCourse`).
const { lessonsApiMock, authMock } = vi.hoisted(() => {
  return {
    lessonsApiMock: {
      getUserCourse: vi.fn(),
      updateCourse: vi.fn(),
      deleteCourse: vi.fn(),
      createLesson: vi.fn(),
      updateLesson: vi.fn(),
      deleteLesson: vi.fn(),
      getUserLesson: vi.fn(),
      getLesson: vi.fn(),
      createStep: vi.fn(),
      updateStepPayload: vi.fn(),
      deleteStep: vi.fn(),
      reorderSteps: vi.fn(),
      markStep: vi.fn(),
      completeLesson: vi.fn(),
      list: vi.fn(),
    },
    authMock: {
      current: { id: 'user-1', username: 'me', email: 'me@x' },
    },
  };
});
const apiMock = {
  getBySlug: lessonsApiMock.getUserCourse,
  update: lessonsApiMock.updateCourse,
  delete: lessonsApiMock.deleteCourse,
  createLesson: lessonsApiMock.createLesson,
  updateLesson: lessonsApiMock.updateLesson,
  deleteLesson: lessonsApiMock.deleteLesson,
  getLesson: lessonsApiMock.getUserLesson,
  createStep: lessonsApiMock.createStep,
  updateStep: lessonsApiMock.updateStepPayload,
  deleteStep: lessonsApiMock.deleteStep,
  reorderSteps: lessonsApiMock.reorderSteps,
  updateStepProgress: lessonsApiMock.markStep,
  completeLesson: lessonsApiMock.completeLesson,
  list: lessonsApiMock.list,
};

vi.mock('../api/lessonsApi', () => ({
  lessonsApi: lessonsApiMock,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: authMock.current
      ? {
          ...authMock.current,
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

import { UserCoursePage } from './UserCoursePage';

function mkCourse(over: Partial<UserCourseDto> = {}): UserCourseDto {
  return {
    id: 'c1',
    ownerId: 'user-1',
    slug: 'my-course',
    title: 'My course',
    description: 'desc',
    isPublic: false,
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
    stepCount: 3,
    ...over,
  };
}

function mkProgress(
  over: Partial<UserCoursePlayProgressDto> = {},
): UserCoursePlayProgressDto {
  return {
    userCourseId: 'c1',
    completedLessonsCount: 0,
    startedAt: '2026-04-24T10:00:00Z',
    lastActivityAt: '2026-04-24T10:00:00Z',
    completedAt: null,
    ...over,
  };
}

function mockBySlug(res: UserCourseWithLessonsResponse | 'error') {
  if (res === 'error') {
    apiMock.getBySlug.mockRejectedValue(new Error('Not found'));
  } else {
    apiMock.getBySlug.mockResolvedValue(res);
  }
}

interface RouterOpts {
  initialPath: string;
  stubLessons?: boolean;
}

function renderRouter({ initialPath, stubLessons }: RouterOpts) {
  return renderWithProviders(
    <Routes>
      <Route path="/lessons/my/:slug" element={<UserCoursePage />} />
      <Route path="/lessons/my/:slug/edit" element={<div data-testid="editor-page" />} />
      {stubLessons && (
        <Route path="/lessons" element={<div data-testid="lessons-page" />} />
      )}
    </Routes>,
    { route: initialPath },
  );
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  authMock.current = { id: 'user-1', username: 'me', email: 'me@x' };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<UserCoursePage>', () => {
  it('loading → ready с уроками и прогрессом', async () => {
    mockBySlug({
      course: mkCourse({ lessonCount: 2, isPublic: true }),
      lessons: [
        mkLesson({ id: 'l1', title: 'L1', order: 0, stepCount: 3 }),
        mkLesson({ id: 'l2', title: 'L2', order: 1, stepCount: 5 }),
      ],
      progress: mkProgress({ completedLessonsCount: 1 }),
    });

    renderRouter({ initialPath: '/lessons/my/my-course' });

    expect(screen.getByTestId('user-course-loading')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('user-course-page')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('user-course-title').textContent).toBe('My course');
    expect(screen.getByTestId('user-course-public-badge')).toBeInTheDocument();
    expect(screen.getByTestId('user-course-progress').textContent).toMatch(/1/);
    expect(screen.getByTestId('user-course-lesson-l1')).toBeInTheDocument();
    expect(screen.getByTestId('user-course-lesson-l2')).toBeInTheDocument();
  });

  /**
   * KS-1882: completion-банер на странице курса.
   * Когда BE проставил `progress.completedAt` (KS-1881) — вместо
   * прогресс-текста показываем баннер «Course completed».
   */
  it('KS-1882 — progress.completedAt → виден completion-banner, прогресс-текста нет', async () => {
    mockBySlug({
      course: mkCourse({ lessonCount: 3 }),
      lessons: [mkLesson({ id: 'l1' })],
      progress: mkProgress({
        completedLessonsCount: 3,
        completedAt: '2026-04-22T10:00:00Z',
      }),
    });

    renderRouter({ initialPath: '/lessons/my/my-course' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-page')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('user-course-completed-banner'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('user-course-progress'),
    ).not.toBeInTheDocument();
  });

  it('KS-1882 — completedAt = null → старый прогресс-текст, баннера нет', async () => {
    mockBySlug({
      course: mkCourse({ lessonCount: 3 }),
      lessons: [mkLesson({ id: 'l1' })],
      progress: mkProgress({ completedLessonsCount: 1, completedAt: null }),
    });

    renderRouter({ initialPath: '/lessons/my/my-course' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-page')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('user-course-progress')).toBeInTheDocument();
    expect(
      screen.queryByTestId('user-course-completed-banner'),
    ).not.toBeInTheDocument();
  });

  /**
   * KS-1886: блок Statistics — виден только владельцу при наличии
   * `course.stats` (BE отдаёт его только owner'у). Не-owner и
   * `stats === undefined` → блок скрыт.
   */
  it('KS-1886 — owner видит блок Statistics со счётчиками', async () => {
    mockBySlug({
      course: mkCourse({
        ownerId: 'user-1',
        stats: { enrolledCount: 5, completedCount: 2, inProgressCount: 3 },
      }),
      lessons: [mkLesson({ id: 'l1' })],
      progress: null,
    });
    renderRouter({ initialPath: '/lessons/my/my-course' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-page')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('user-course-stats')).toBeInTheDocument();
    expect(screen.getByTestId('user-course-stats-enrolled').textContent).toContain('5');
    // 2/5 = 40%
    expect(screen.getByTestId('user-course-stats-completed').textContent).toContain('2');
    expect(screen.getByTestId('user-course-stats-completed').textContent).toContain('40');
    expect(screen.getByTestId('user-course-stats-in-progress').textContent).toContain('3');
  });

  it('KS-1886 — student (не-owner) → блок Statistics скрыт', async () => {
    authMock.current = { id: 'student-1', username: 'st', email: 's@x' };
    mockBySlug({
      course: mkCourse({ ownerId: 'user-1', isPublic: true }),
      // stats не приходит для не-owner'а
      lessons: [mkLesson({ id: 'l1' })],
      progress: null,
    });
    renderRouter({ initialPath: '/lessons/my/my-course' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-page')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('user-course-stats')).not.toBeInTheDocument();
  });

  it("KS-1886 — stats отсутствует у owner'а → блок скрыт", async () => {
    mockBySlug({
      course: mkCourse({ ownerId: 'user-1' }), // без stats
      lessons: [mkLesson({ id: 'l1' })],
      progress: null,
    });
    renderRouter({ initialPath: '/lessons/my/my-course' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-page')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('user-course-stats')).not.toBeInTheDocument();
  });

  it('KS-1886 — enrolledCount = 0 → percent скрыт (защита от деления на 0)', async () => {
    mockBySlug({
      course: mkCourse({
        ownerId: 'user-1',
        stats: { enrolledCount: 0, completedCount: 0, inProgressCount: 0 },
      }),
      lessons: [mkLesson({ id: 'l1' })],
      progress: null,
    });
    renderRouter({ initialPath: '/lessons/my/my-course' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-page')).toBeInTheDocument(),
    );
    const completed = screen.getByTestId('user-course-stats-completed');
    expect(completed.textContent).toContain('0');
    expect(completed.textContent).not.toContain('%');
  });

  it('lessons сортируются по order', async () => {
    mockBySlug({
      course: mkCourse(),
      lessons: [
        mkLesson({ id: 'l3', order: 2 }),
        mkLesson({ id: 'l1', order: 0 }),
        mkLesson({ id: 'l2', order: 1 }),
      ],
      progress: null,
    });
    renderRouter({ initialPath: '/lessons/my/my-course' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-page')).toBeInTheDocument(),
    );
    const section = screen.getByTestId('user-course-lessons');
    const ids = Array.from(
      section.querySelectorAll('[data-testid^="user-course-lesson-"]'),
    )
      .map((el) => el.getAttribute('data-testid'))
      .filter((id): id is string => id !== null && /^user-course-lesson-l\d$/.test(id));
    expect(ids).toEqual([
      'user-course-lesson-l1',
      'user-course-lesson-l2',
      'user-course-lesson-l3',
    ]);
  });

  it('404 при ошибке загрузки (не раскрываем чужой приватный)', async () => {
    mockBySlug('error');
    renderRouter({ initialPath: '/lessons/my/missing' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-404')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('user-course-page')).not.toBeInTheDocument();
  });

  it('owner видит owner-actions (Edit / Toggle / Delete)', async () => {
    mockBySlug({
      course: mkCourse({ ownerId: 'user-1', isPublic: false }),
      lessons: [],
      progress: null,
    });
    renderRouter({ initialPath: '/lessons/my/my-course' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-page')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('user-course-owner-actions')).toBeInTheDocument();
    expect(screen.getByTestId('user-course-edit')).toBeInTheDocument();
    expect(screen.getByTestId('user-course-toggle-visibility').textContent)
      .toMatch(/public/i);
    expect(screen.getByTestId('user-course-delete')).toBeInTheDocument();
  });

  it('не-owner публичного курса видит только CTA уроков, без actions', async () => {
    authMock.current = { id: 'other-user', username: 'other', email: 'o@x' };
    mockBySlug({
      course: mkCourse({ ownerId: 'user-1', isPublic: true }),
      lessons: [mkLesson({ id: 'l1' })],
      progress: null,
    });
    renderRouter({ initialPath: '/lessons/my/my-course' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-page')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('user-course-owner-actions')).not.toBeInTheDocument();
    expect(screen.getByTestId('user-course-lesson-play-l1')).toHaveAttribute(
      'href',
      '/lessons/my/my-course/l1',
    );
  });

  it('Toggle visibility → userCoursesApi.update({isPublic: true})', async () => {
    mockBySlug({
      course: mkCourse({ isPublic: false }),
      lessons: [],
      progress: null,
    });
    apiMock.update.mockResolvedValue(mkCourse({ isPublic: true }));

    renderRouter({ initialPath: '/lessons/my/my-course' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-page')).toBeInTheDocument(),
    );

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByTestId('user-course-toggle-visibility'));

    await waitFor(() =>
      expect(apiMock.update).toHaveBeenCalledWith('c1', { isPublic: true }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('user-course-public-badge')).toBeInTheDocument(),
    );
  });

  it('Delete с подтверждением → userCoursesApi.delete + редирект', async () => {
    mockBySlug({ course: mkCourse(), lessons: [], progress: null });
    apiMock.delete.mockResolvedValue(undefined);
    const confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmMock);

    renderRouter({
      initialPath: '/lessons/my/my-course',
      stubLessons: true,
    });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-page')).toBeInTheDocument(),
    );

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByTestId('user-course-delete'));
    await waitFor(() => expect(apiMock.delete).toHaveBeenCalledWith('c1'));
    await waitFor(() =>
      expect(screen.getByTestId('lessons-page')).toBeInTheDocument(),
    );
    vi.unstubAllGlobals();
  });

  it('Delete без подтверждения → api.delete не вызывается', async () => {
    mockBySlug({ course: mkCourse(), lessons: [], progress: null });
    const confirmMock = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirmMock);

    renderRouter({ initialPath: '/lessons/my/my-course' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-page')).toBeInTheDocument(),
    );

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByTestId('user-course-delete'));
    // microtask flush
    await Promise.resolve();
    expect(apiMock.delete).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('Edit ведёт на /lessons/my/:slug/edit', async () => {
    mockBySlug({ course: mkCourse(), lessons: [], progress: null });
    renderRouter({ initialPath: '/lessons/my/my-course' });
    await waitFor(() =>
      expect(screen.getByTestId('user-course-page')).toBeInTheDocument(),
    );
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByTestId('user-course-edit'));
    await waitFor(() =>
      expect(screen.getByTestId('editor-page')).toBeInTheDocument(),
    );
  });
});
