import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * KS-1922: тесты `useLessonsHeroContext` — приоритет 5 состояний.
 */

const { apiMock, authMock } = vi.hoisted(() => ({
  apiMock: {
    listEnrolled: vi.fn(),
    list: vi.fn(),
  },
  authMock: {
    user: null as { id: string; username: string } | null,
    loading: false,
  },
}));

vi.mock('../api/userCoursesApi', () => ({
  userCoursesApi: apiMock,
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
  apiMock.listEnrolled.mockReset();
  apiMock.list.mockReset();
  authMock.user = null;
  authMock.loading = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useLessonsHeroContext', () => {
  it('user=null → state=guest, fetch не вызывается', () => {
    const { result } = renderHook(() => useLessonsHeroContext());
    expect(result.current.state.kind).toBe('guest');
    expect(apiMock.listEnrolled).not.toHaveBeenCalled();
    expect(apiMock.list).not.toHaveBeenCalled();
  });

  it('auth.loading=true → state=loading', () => {
    authMock.loading = true;
    const { result } = renderHook(() => useLessonsHeroContext());
    expect(result.current.state.kind).toBe('loading');
  });

  it('user есть, fetch не отдал → loading; затем state переходит', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    apiMock.listEnrolled.mockResolvedValue({ data: [] });
    apiMock.list.mockResolvedValue({ data: [] });
    const { result } = renderHook(() => useLessonsHeroContext());
    expect(result.current.state.kind).toBe('loading');
    await waitFor(() => {
      expect(result.current.state.kind).toBe('start');
    });
  });

  it('priority P1: enrolled с незавершённым курсом → continue (берёт самый свежий lastActivityAt)', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    apiMock.listEnrolled.mockResolvedValue({
      data: [
        {
          id: 'c-old',
          ownerId: 'a1',
          slug: 'old',
          title: 'Old',
          description: null,
          isPublic: true,
          createdAt: '2026-04-01T00:00:00Z',
          updatedAt: '2026-04-01T00:00:00Z',
          lessonCount: 5,
          progress: {
            userCourseId: 'c-old',
            completedLessonsCount: 1,
            startedAt: '2026-04-01T00:00:00Z',
            lastActivityAt: '2026-04-10T00:00:00Z',
            completedAt: null,
          },
        },
        {
          id: 'c-new',
          ownerId: 'a2',
          slug: 'new',
          title: 'New',
          description: null,
          isPublic: true,
          createdAt: '2026-04-02T00:00:00Z',
          updatedAt: '2026-04-02T00:00:00Z',
          lessonCount: 5,
          progress: {
            userCourseId: 'c-new',
            completedLessonsCount: 2,
            startedAt: '2026-04-02T00:00:00Z',
            lastActivityAt: '2026-04-25T00:00:00Z',
            completedAt: null,
          },
        },
        {
          id: 'c-done',
          ownerId: 'a3',
          slug: 'done',
          title: 'Completed',
          description: null,
          isPublic: true,
          createdAt: '2026-04-03T00:00:00Z',
          updatedAt: '2026-04-03T00:00:00Z',
          lessonCount: 5,
          progress: {
            userCourseId: 'c-done',
            completedLessonsCount: 5,
            startedAt: '2026-04-03T00:00:00Z',
            lastActivityAt: '2026-04-26T00:00:00Z',
            completedAt: '2026-04-26T00:00:00Z',
          },
        },
      ],
    });
    apiMock.list.mockResolvedValue({
      data: [
        {
          id: 'own',
          ownerId: 'u1',
          slug: 'own',
          title: 'Own',
          description: null,
          isPublic: false,
          createdAt: '2026-04-01T00:00:00Z',
          updatedAt: '2026-04-01T00:00:00Z',
          lessonCount: 0,
        },
      ],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('continue'));
    expect(
      result.current.state.kind === 'continue' && result.current.state.course.id,
    ).toBe('c-new');
    // Завершённый c-done не выбран, хотя lastActivityAt свежее.
  });

  it('priority P4: нет незавершённых enrolled, есть свои → author', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    apiMock.listEnrolled.mockResolvedValue({ data: [] });
    apiMock.list.mockResolvedValue({
      data: [
        {
          id: 'c1',
          ownerId: 'u1',
          slug: 'c1',
          title: 'C1',
          description: null,
          isPublic: true,
          createdAt: '2026-04-01T00:00:00Z',
          updatedAt: '2026-04-10T00:00:00Z',
          lessonCount: 5,
        },
        {
          id: 'c2',
          ownerId: 'u1',
          slug: 'c2',
          title: 'C2',
          description: null,
          isPublic: false,
          createdAt: '2026-04-02T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          lessonCount: 5,
        },
      ],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('author'));
    if (result.current.state.kind !== 'author') throw new Error('not author');
    expect(result.current.state.ownedCount).toBe(2);
    expect(result.current.state.publicCount).toBe(1);
    expect(result.current.state.privateCount).toBe(1);
    expect(result.current.state.latestCourse?.id).toBe('c2');
  });

  it('priority P2: нет ни enrolled, ни своих → start', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    apiMock.listEnrolled.mockResolvedValue({ data: [] });
    apiMock.list.mockResolvedValue({ data: [] });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('start'));
  });

  it('priority: enrolled-in-progress + own → continue (P1 важнее P4)', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    apiMock.listEnrolled.mockResolvedValue({
      data: [
        {
          id: 'in-progress',
          ownerId: 'a1',
          slug: 'ip',
          title: 'In progress',
          description: null,
          isPublic: true,
          createdAt: '2026-04-01T00:00:00Z',
          updatedAt: '2026-04-01T00:00:00Z',
          lessonCount: 5,
          progress: {
            userCourseId: 'in-progress',
            completedLessonsCount: 1,
            startedAt: '2026-04-01T00:00:00Z',
            lastActivityAt: '2026-04-10T00:00:00Z',
            completedAt: null,
          },
        },
      ],
    });
    apiMock.list.mockResolvedValue({
      data: [
        {
          id: 'own',
          ownerId: 'u1',
          slug: 'own',
          title: 'Own',
          description: null,
          isPublic: true,
          createdAt: '2026-04-01T00:00:00Z',
          updatedAt: '2026-04-01T00:00:00Z',
          lessonCount: 5,
        },
      ],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    await waitFor(() => expect(result.current.state.kind).toBe('continue'));
  });

  it('errored fetch → деградирует в state без падения (treat as empty)', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    apiMock.listEnrolled.mockRejectedValue(new Error('boom'));
    apiMock.list.mockResolvedValue({
      data: [
        {
          id: 'own',
          ownerId: 'u1',
          slug: 'own',
          title: 'Own',
          description: null,
          isPublic: true,
          createdAt: '2026-04-01T00:00:00Z',
          updatedAt: '2026-04-01T00:00:00Z',
          lessonCount: 5,
        },
      ],
    });
    const { result } = renderHook(() => useLessonsHeroContext());
    // enrolled завершился с ошибкой → пустой массив, mine=1 → P4
    await waitFor(() => expect(result.current.state.kind).toBe('author'));
  });
});
