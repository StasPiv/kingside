import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * KS-1922 + KS-1938 + KS-1957: тесты `useLessonsHeroContext`.
 *
 * После KS-1957 (F-12) активные курсы приходят одним запросом
 * `lessonsApi.listActiveCourses()` (агрегат system + enrolled).
 * `lessonsApi.listCourses()` тут нужен только для `beginnerSlug`
 * (variant `start`), а `userCoursesApi.list({scope:'own'})` — для
 * variant `author`.
 *
 * Иерархия (от высоким к низ):
 *   guest → loading → multi → continue → author → start
 */

const { lessonsApiMock, userCoursesApiMock, authMock } = vi.hoisted(() => ({
  lessonsApiMock: {
    listCourses: vi.fn(),
    listActiveCourses: vi.fn(),
  },
  userCoursesApiMock: {
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
  lessonsApiMock.listActiveCourses.mockReset();
  userCoursesApiMock.list.mockReset();
  authMock.user = null;
  authMock.loading = false;
  // Дефолты — пустые массивы (отсутствие данных).
  lessonsApiMock.listCourses.mockResolvedValue({ data: [] });
  lessonsApiMock.listActiveCourses.mockResolvedValue([]);
  userCoursesApiMock.list.mockResolvedValue({ data: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Helpers ────────────────────────────────────────────────────────────

function activeSystem(over: Record<string, unknown> = {}) {
  return {
    kind: 'system',
    id: over.id ?? 'sys',
    slug: over.slug ?? 'sys',
    level: over.level ?? 'beginner',
    titleI18nKey: over.titleI18nKey ?? `${over.slug ?? 'sys'}-title`,
    descriptionI18nKey: 'd',
    lessonCount: over.lessonCount ?? 5,
    lessonsCompleted: over.lessonsCompleted ?? 1,
    lastActivityAt: over.lastActivityAt ?? '2026-04-20T00:00:00Z',
    currentLessonSlug: over.currentLessonSlug ?? null,
    currentLessonTitleI18nKey: over.currentLessonTitleI18nKey ?? null,
    currentLessonOrder: over.currentLessonOrder ?? null,
    coverUrl: over.coverUrl ?? null,
    ...over,
  };
}

function activeEnrolled(over: Record<string, unknown> = {}) {
  return {
    kind: 'enrolled',
    id: over.id ?? 'enr',
    slug: over.slug ?? 'enr',
    title: over.title ?? 'Title',
    description: null,
    ownerId: 'o',
    lessonCount: over.lessonCount ?? 4,
    lessonsCompleted: over.lessonsCompleted ?? 1,
    lastActivityAt: over.lastActivityAt ?? '2026-04-22T00:00:00Z',
    currentLessonSlug: over.currentLessonSlug ?? null,
    currentLessonTitle: over.currentLessonTitle ?? null,
    currentLessonOrder: over.currentLessonOrder ?? null,
    ...over,
  };
}

function systemCourse(opts: {
  slug: string;
  level?: 'beginner' | 'intermediate' | 'advanced';
  order?: number;
}) {
  return {
    id: `sys-${opts.slug}`,
    slug: opts.slug,
    level: opts.level ?? 'beginner',
    titleI18nKey: `${opts.slug}-title`,
    descriptionI18nKey: `${opts.slug}-desc`,
    order: opts.order ?? 1,
    lessonCount: 5,
    coverUrl: null,
    progress: null,
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
    expect(lessonsApiMock.listActiveCourses).not.toHaveBeenCalled();
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

  it('≥2 активных → multi с count=N (бэк уже отсортировал)', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listActiveCourses.mockResolvedValue([
      activeSystem({
        id: 'sys-active',
        slug: 'sys-active',
        lastActivityAt: '2026-04-25T00:00:00Z',
      }),
      activeEnrolled({
        id: 'e1',
        slug: 'e1',
        lastActivityAt: '2026-04-22T00:00:00Z',
      }),
      activeEnrolled({
        id: 'e2',
        slug: 'e2',
        lastActivityAt: '2026-04-20T00:00:00Z',
      }),
    ]);
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('multi'));
    if (result.current.state.kind !== 'multi') throw new Error('not multi');
    expect(result.current.state.count).toBe(3);
  });

  it('multi важнее author: автор с 2 активными → multi, не author', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listActiveCourses.mockResolvedValue([
      activeEnrolled({ id: 'a', slug: 'a' }),
      activeEnrolled({ id: 'b', slug: 'b' }),
    ]);
    userCoursesApiMock.list.mockResolvedValue({
      data: [ownCourse({ id: 'own1' })],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('multi'));
  });

  // ─── continue ───

  it('1 активный (enrolled) → continue с маппингом в ActiveCourseSummary', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listActiveCourses.mockResolvedValue([
      activeEnrolled({
        id: 'e1',
        slug: 'caro-kann',
        title: 'Caro-Kann basics',
        lessonCount: 4,
        lessonsCompleted: 2,
      }),
    ]);
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('continue'));
    if (result.current.state.kind !== 'continue') throw new Error('!continue');
    expect(result.current.state.course.source).toBe('enrolled');
    expect(result.current.state.course.slug).toBe('caro-kann');
    expect(result.current.state.course.title).toBe('Caro-Kann basics');
    expect(result.current.state.course.completedLessons).toBe(2);
    expect(result.current.state.course.lessonCount).toBe(4);
    expect(result.current.state.course.href).toBe('/lessons/my/caro-kann');
  });

  it('1 активный (system) → continue с href=/lessons/<slug>', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listActiveCourses.mockResolvedValue([
      activeSystem({
        id: 'sys',
        slug: 'beginner-basics',
        level: 'beginner',
        lessonCount: 8,
        lessonsCompleted: 3,
      }),
    ]);
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

  // KS-1955: проброс новых полей progress (currentLesson*).
  it('continue (system): currentLesson* и lastActivityAt прорастают в state', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listActiveCourses.mockResolvedValue([
      activeSystem({
        slug: 'beginner-basics',
        lastActivityAt: '2026-04-25T00:00:00Z',
        currentLessonSlug: 'king-pawn',
        currentLessonTitleI18nKey: 'king-pawn-title',
        currentLessonOrder: 5,
      }),
    ]);
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

  it('continue (enrolled): currentLessonTitle (без i18n) прорастает', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listActiveCourses.mockResolvedValue([
      activeEnrolled({
        slug: 'caro-kann',
        lastActivityAt: '2026-04-22T00:00:00Z',
        currentLessonSlug: 'main-line',
        currentLessonTitle: 'Главный вариант',
        currentLessonOrder: 3,
      }),
    ]);
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('continue'));
    if (result.current.state.kind !== 'continue') throw new Error('!continue');
    expect(result.current.state.course.currentLessonTitle).toBe(
      'Главный вариант',
    );
    expect(result.current.state.course.currentLessonTitleI18nKey).toBeNull();
    expect(result.current.state.course.currentLessonOrder).toBe(3);
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
        systemCourse({ slug: 'intermediate-x', level: 'intermediate', order: 1 }),
        systemCourse({ slug: 'beginner-second', level: 'beginner', order: 2 }),
        systemCourse({ slug: 'beginner-first', level: 'beginner', order: 1 }),
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
      data: [systemCourse({ slug: 'i1', level: 'intermediate' })],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('start'));
    if (result.current.state.kind !== 'start') throw new Error('!start');
    expect(result.current.state.beginnerSlug).toBeNull();
    expect(result.current.state.beginnerTitleI18nKey).toBeNull();
  });

  // ─── деградация при ошибках ───

  it('listActiveCourses errored → деградирует мягко (active=пустой массив)', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listActiveCourses.mockRejectedValue(new Error('boom'));
    userCoursesApiMock.list.mockResolvedValue({
      data: [ownCourse({ id: 'c1' })],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    // нет active → idem пустой массив, есть own → author
    await waitFor(() => expect(result.current.state.kind).toBe('author'));
  });

  it('все три errored → start с beginnerSlug=null', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    lessonsApiMock.listActiveCourses.mockRejectedValue(new Error('boom'));
    lessonsApiMock.listCourses.mockRejectedValue(new Error('boom'));
    userCoursesApiMock.list.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('start'));
    expect(
      result.current.state.kind === 'start' &&
        result.current.state.beginnerSlug,
    ).toBeNull();
  });

  // ─── KS-1957 контракт ───

  it('KS-1957: НЕ дёргает userCoursesApi.listEnrolled — заменён на listActiveCourses', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).not.toBe('loading'));
    expect(lessonsApiMock.listActiveCourses).toHaveBeenCalled();
    // listEnrolled больше не используется этим хуком — поэтому в моке
    // его вообще нет. Тут защита: если кто-то вернёт useCoursesApi.listEnrolled
    // обратно, тест провалится с TypeError.
    expect(
      (userCoursesApiMock as unknown as { listEnrolled?: unknown }).listEnrolled,
    ).toBeUndefined();
  });
});
