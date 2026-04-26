import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * KS-1922 + KS-1938: тесты `useLessonsHeroContext` — приоритет 6 состояний.
 *
 * Иерархия (от выс к низ):
 *   guest → loading → multi → continue → author → start
 *
 * `multi` и `continue` теперь ВЫШЕ `author` (по концепту KS-1931 §3.2):
 * автор с активным прогрессом видит progress-карточку, а не «Open editor».
 */

const { lessonsApiMock, userCoursesApiMock, authMock } = vi.hoisted(() => ({
  lessonsApiMock: {
    listCourses: vi.fn(),
  },
  userCoursesApiMock: {
    listEnrolled: vi.fn(),
    list: vi.fn(),
  },
  authMock: {
    user: null as { id: string; username: string } | null,
    loading: false,
  },
}));

vi.mock('../api/lessonsApi', () => ({
  lessonsApi: lessonsApiMock,
}));

vi.mock('../api/userCoursesApi', () => ({
  userCoursesApi: userCoursesApiMock,
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
    loading: authMock.loading,
  }),
}));

import { useLessonsHeroContext } from './useLessonsHeroContext';

beforeEach(() => {
  lessonsApiMock.listCourses.mockReset();
  userCoursesApiMock.listEnrolled.mockReset();
  userCoursesApiMock.list.mockReset();
  authMock.user = null;
  authMock.loading = false;
  // Дефолты — пустые массивы (отсутствие данных).
  lessonsApiMock.listCourses.mockResolvedValue({ data: [] });
  userCoursesApiMock.listEnrolled.mockResolvedValue({ data: [] });
  userCoursesApiMock.list.mockResolvedValue({ data: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Helpers для построения DTO ────────────────────────────────────────

function systemCourse(opts: {
  slug: string;
  level?: 'beginner' | 'intermediate' | 'advanced';
  order?: number;
  lessonCount?: number;
  progress?: {
    lessonsCompleted: number;
    startedAt: string;
    completedAt: string | null;
    lastActivityAt?: string;
    currentLessonSlug?: string | null;
    currentLessonTitleI18nKey?: string | null;
    currentLessonOrder?: number | null;
  } | null;
  coverUrl?: string | null;
}) {
  return {
    id: `sys-${opts.slug}`,
    slug: opts.slug,
    level: opts.level ?? 'beginner',
    titleI18nKey: `${opts.slug}-title`,
    descriptionI18nKey: `${opts.slug}-desc`,
    order: opts.order ?? 1,
    lessonCount: opts.lessonCount ?? 5,
    coverUrl: opts.coverUrl ?? null,
    progress: opts.progress
      ? {
          ...opts.progress,
          currentLessonId: null,
          // KS-1955: новые поля прогресса. По умолчанию заполняем
          // корректными значениями, тесты могут переопределить.
          lastActivityAt:
            opts.progress.lastActivityAt ?? opts.progress.startedAt,
          currentLessonSlug:
            opts.progress.currentLessonSlug ?? null,
          currentLessonTitleI18nKey:
            opts.progress.currentLessonTitleI18nKey ?? null,
          currentLessonOrder:
            opts.progress.currentLessonOrder ?? null,
        }
      : opts.progress, // null или undefined
  };
}

function enrolledCourse(opts: {
  slug: string;
  lastActivityAt: string;
  completedAt?: string | null;
  lessonCount?: number;
  completedLessonsCount?: number;
  coverUrl?: string | null;
  currentLessonSlug?: string | null;
  currentLessonTitle?: string | null;
  currentLessonOrder?: number | null;
}) {
  return {
    id: `e-${opts.slug}`,
    ownerId: `o-${opts.slug}`,
    slug: opts.slug,
    title: `Title ${opts.slug}`,
    description: null,
    isPublic: true,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    lessonCount: opts.lessonCount ?? 5,
    coverUrl: opts.coverUrl ?? null,
    progress: {
      userCourseId: `e-${opts.slug}`,
      completedLessonsCount: opts.completedLessonsCount ?? 1,
      startedAt: '2026-04-01T00:00:00Z',
      lastActivityAt: opts.lastActivityAt,
      completedAt: opts.completedAt ?? null,
      // KS-1955: новые поля.
      currentLessonSlug: opts.currentLessonSlug ?? null,
      currentLessonTitle: opts.currentLessonTitle ?? null,
      currentLessonOrder: opts.currentLessonOrder ?? null,
    },
  };
}

function ownCourse(opts: {
  id: string;
  slug?: string;
  isPublic?: boolean;
  updatedAt?: string;
}) {
  return {
    id: opts.id,
    ownerId: 'u1',
    slug: opts.slug ?? opts.id,
    title: opts.id,
    description: null,
    isPublic: opts.isPublic ?? true,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: opts.updatedAt ?? '2026-04-01T00:00:00Z',
    lessonCount: 5,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('useLessonsHeroContext', () => {
  it('user=null → state=guest, fetch не вызывается', () => {
    const { result } = renderHook(() => useLessonsHeroContext());
    expect(result.current.state.kind).toBe('guest');
    expect(lessonsApiMock.listCourses).not.toHaveBeenCalled();
    expect(userCoursesApiMock.listEnrolled).not.toHaveBeenCalled();
    expect(userCoursesApiMock.list).not.toHaveBeenCalled();
  });

  it('auth.loading=true → state=loading', () => {
    authMock.loading = true;
    const { result } = renderHook(() => useLessonsHeroContext());
    expect(result.current.state.kind).toBe('loading');
  });

  it('user есть, fetch не отдал → loading; затем state переходит', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    const { result } = renderHook(() => useLessonsHeroContext());
    expect(result.current.state.kind).toBe('loading');
    await waitFor(() => {
      expect(result.current.state.kind).toBe('start');
    });
  });

  // ─── multi ───

  it('≥2 активных (system + enrolled) → multi с count=N', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listCourses.mockResolvedValue({
      data: [
        systemCourse({
          slug: 'sys-active',
          progress: {
            lessonsCompleted: 2,
            startedAt: '2026-04-10T00:00:00Z',
            completedAt: null,
          },
        }),
      ],
    });
    userCoursesApiMock.listEnrolled.mockResolvedValue({
      data: [
        enrolledCourse({ slug: 'e1', lastActivityAt: '2026-04-20T00:00:00Z' }),
        enrolledCourse({ slug: 'e2', lastActivityAt: '2026-04-22T00:00:00Z' }),
      ],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('multi'));
    if (result.current.state.kind !== 'multi') throw new Error('not multi');
    expect(result.current.state.count).toBe(3);
  });

  it('только system 2 активных → multi (enrolled = пустой)', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listCourses.mockResolvedValue({
      data: [
        systemCourse({
          slug: 's1',
          progress: {
            lessonsCompleted: 1,
            startedAt: '2026-04-10T00:00:00Z',
            completedAt: null,
          },
        }),
        systemCourse({
          slug: 's2',
          progress: {
            lessonsCompleted: 2,
            startedAt: '2026-04-12T00:00:00Z',
            completedAt: null,
          },
        }),
      ],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('multi'));
    expect(
      result.current.state.kind === 'multi' && result.current.state.count,
    ).toBe(2);
  });

  it('multi важнее author: автор с 2 активными → multi, не author', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    userCoursesApiMock.listEnrolled.mockResolvedValue({
      data: [
        enrolledCourse({ slug: 'a', lastActivityAt: '2026-04-10T00:00:00Z' }),
        enrolledCourse({ slug: 'b', lastActivityAt: '2026-04-11T00:00:00Z' }),
      ],
    });
    userCoursesApiMock.list.mockResolvedValue({
      data: [ownCourse({ id: 'own1' })],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('multi'));
  });

  // ─── continue ───

  it('1 активный (enrolled) → continue с маппингом в ActiveCourseSummary', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    userCoursesApiMock.listEnrolled.mockResolvedValue({
      data: [
        enrolledCourse({
          slug: 'caro-kann',
          lastActivityAt: '2026-04-20T00:00:00Z',
          completedLessonsCount: 2,
          lessonCount: 4,
          coverUrl: 'https://cdn/x.jpg',
        }),
      ],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('continue'));
    if (result.current.state.kind !== 'continue') throw new Error('!continue');
    expect(result.current.state.course.source).toBe('enrolled');
    expect(result.current.state.course.slug).toBe('caro-kann');
    expect(result.current.state.course.completedLessons).toBe(2);
    expect(result.current.state.course.lessonCount).toBe(4);
    expect(result.current.state.course.coverUrl).toBe('https://cdn/x.jpg');
    expect(result.current.state.course.href).toBe('/lessons/my/caro-kann');
  });

  it('1 активный (system) → continue с href=/lessons/<slug>', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listCourses.mockResolvedValue({
      data: [
        systemCourse({
          slug: 'beginner-basics',
          level: 'beginner',
          lessonCount: 8,
          progress: {
            lessonsCompleted: 3,
            startedAt: '2026-04-10T00:00:00Z',
            completedAt: null,
          },
        }),
      ],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('continue'));
    if (result.current.state.kind !== 'continue') throw new Error('!continue');
    expect(result.current.state.course.source).toBe('system');
    expect(result.current.state.course.titleI18nKey).toBe(
      'beginner-basics-title',
    );
    expect(result.current.state.course.level).toBe('beginner');
    expect(result.current.state.course.completedLessons).toBe(3);
    expect(result.current.state.course.href).toBe('/lessons/beginner-basics');
  });

  // ─── KS-1955 / KS-1938: проброс новых полей progress ───

  it('continue (system): currentLesson* и lastActivityAt пробрасываются в state', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listCourses.mockResolvedValue({
      data: [
        systemCourse({
          slug: 'beginner-basics',
          level: 'beginner',
          lessonCount: 8,
          progress: {
            lessonsCompleted: 4,
            startedAt: '2026-04-10T00:00:00Z',
            completedAt: null,
            lastActivityAt: '2026-04-25T00:00:00Z',
            currentLessonSlug: 'king-pawn',
            currentLessonTitleI18nKey: 'king-pawn-title',
            currentLessonOrder: 5,
          },
        }),
      ],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('continue'));
    if (result.current.state.kind !== 'continue') throw new Error('!continue');
    expect(result.current.state.course.lastActivityAt).toBe(
      '2026-04-25T00:00:00Z',
    );
    expect(result.current.state.course.currentLessonSlug).toBe('king-pawn');
    expect(result.current.state.course.currentLessonTitleI18nKey).toBe(
      'king-pawn-title',
    );
    expect(result.current.state.course.currentLessonTitle).toBeNull();
    expect(result.current.state.course.currentLessonOrder).toBe(5);
  });

  it('continue (enrolled): currentLessonTitle (без i18n) и lastActivityAt в state', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    userCoursesApiMock.listEnrolled.mockResolvedValue({
      data: [
        enrolledCourse({
          slug: 'caro-kann',
          lastActivityAt: '2026-04-22T00:00:00Z',
          completedLessonsCount: 2,
          lessonCount: 4,
          currentLessonSlug: 'main-line',
          currentLessonTitle: 'Главный вариант',
          currentLessonOrder: 3,
        }),
      ],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('continue'));
    if (result.current.state.kind !== 'continue') throw new Error('!continue');
    expect(result.current.state.course.lastActivityAt).toBe(
      '2026-04-22T00:00:00Z',
    );
    expect(result.current.state.course.currentLessonTitle).toBe(
      'Главный вариант',
    );
    expect(result.current.state.course.currentLessonTitleI18nKey).toBeNull();
    expect(result.current.state.course.currentLessonOrder).toBe(3);
  });

  it('continue: завершённые курсы (completedAt != null) НЕ считаются активными', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    userCoursesApiMock.listEnrolled.mockResolvedValue({
      data: [
        enrolledCourse({
          slug: 'ip',
          lastActivityAt: '2026-04-20T00:00:00Z',
        }),
        enrolledCourse({
          slug: 'done',
          lastActivityAt: '2026-04-26T00:00:00Z',
          completedAt: '2026-04-26T00:00:00Z',
        }),
      ],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('continue'));
    expect(
      result.current.state.kind === 'continue' &&
        result.current.state.course.slug,
    ).toBe('ip');
  });

  it('continue: при mix system+enrolled берёт самый свежий по lastActivityAt', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listCourses.mockResolvedValue({
      data: [
        systemCourse({
          slug: 'sys-old',
          progress: {
            lessonsCompleted: 1,
            startedAt: '2026-04-01T00:00:00Z',
            completedAt: null,
          },
        }),
      ],
    });
    userCoursesApiMock.listEnrolled.mockResolvedValue({
      data: [], // 1 активный итого — system
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('continue'));
    expect(
      result.current.state.kind === 'continue' &&
        result.current.state.course.slug,
    ).toBe('sys-old');
  });

  // ─── author ───

  it('0 активных, есть свои → author', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    userCoursesApiMock.list.mockResolvedValue({
      data: [
        ownCourse({ id: 'c1', isPublic: true, updatedAt: '2026-04-10' }),
        ownCourse({ id: 'c2', isPublic: false, updatedAt: '2026-04-20' }),
      ],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('author'));
    if (result.current.state.kind !== 'author') throw new Error('!author');
    expect(result.current.state.ownedCount).toBe(2);
    expect(result.current.state.publicCount).toBe(1);
    expect(result.current.state.privateCount).toBe(1);
    expect(result.current.state.latestCourse?.id).toBe('c2');
  });

  // ─── start ───

  it('0 активных, нет своих → start с beginnerSlug первого beginner-курса', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listCourses.mockResolvedValue({
      data: [
        systemCourse({
          slug: 'intermediate-x',
          level: 'intermediate',
          order: 1,
        }),
        systemCourse({
          slug: 'beginner-second',
          level: 'beginner',
          order: 2,
        }),
        systemCourse({
          slug: 'beginner-first',
          level: 'beginner',
          order: 1,
        }),
      ],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('start'));
    if (result.current.state.kind !== 'start') throw new Error('!start');
    expect(result.current.state.beginnerSlug).toBe('beginner-first');
    expect(result.current.state.beginnerTitleI18nKey).toBe(
      'beginner-first-title',
    );
  });

  it('start: нет beginner-курсов → beginnerSlug=null', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listCourses.mockResolvedValue({
      data: [
        systemCourse({ slug: 'i1', level: 'intermediate' }),
      ],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('start'));
    if (result.current.state.kind !== 'start') throw new Error('!start');
    expect(result.current.state.beginnerSlug).toBeNull();
    expect(result.current.state.beginnerTitleI18nKey).toBeNull();
  });

  // ─── деградация при ошибках ───

  it('listCourses errored → деградирует мягко (system=пустой массив)', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listCourses.mockRejectedValue(new Error('boom'));
    userCoursesApiMock.list.mockResolvedValue({
      data: [ownCourse({ id: 'c1' })],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    // нет system, нет enrolled, есть own → author
    await waitFor(() => expect(result.current.state.kind).toBe('author'));
  });

  it('все три errored → start с beginnerSlug=null', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listCourses.mockRejectedValue(new Error('boom'));
    userCoursesApiMock.listEnrolled.mockRejectedValue(new Error('boom'));
    userCoursesApiMock.list.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('start'));
    expect(
      result.current.state.kind === 'start' &&
        result.current.state.beginnerSlug,
    ).toBeNull();
  });
});
