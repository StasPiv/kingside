/**
 * KS-3971 / ADR-119 C02. Тесты `useLectureAccess`.
 *
 * Покрытие:
 *  - первичный GET /lectures/:id/access заполняет grants;
 *  - 401/403 → error=forbidden; 404 → not-found; прочее → load-failed;
 *  - grantUser: оптимистичная вставка, после ответа подменяется на
 *    реальный grant; при ошибке откат + lastMutationError;
 *  - revokeGrant: оптимистичное удаление, при ошибке откат;
 *  - grantUser идемпотентен (повторное добавление того же userId
 *    — no-op);
 *  - refetch триггерит новый GET.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { LectureAccessGrantWithUser } from '@kingside/shared';
import { ApiError } from '../ApiError';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiDelete = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: (path: string) => apiGet(path),
    post: (path: string, body: unknown) => apiPost(path, body),
    delete: (path: string) => apiDelete(path),
  },
}));

import { useLectureAccess } from './useLectureAccess';

const LECTURE = 'lec-1';

function makeGrant(
  id: string,
  userId: string,
  username = userId,
): LectureAccessGrantWithUser {
  return {
    grant: {
      id,
      lectureId: LECTURE,
      subjectType: 'user',
      subjectId: userId,
      grantedById: 'owner-1',
      grantedAt: '2026-06-08T00:00:00.000Z',
    },
    user: {
      id: userId,
      username,
      displayName: username,
    },
  };
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiDelete.mockReset();
});

describe('useLectureAccess KS-3971', () => {
  it('первичный GET наполняет grants', async () => {
    const g = makeGrant('g1', 'u1');
    apiGet.mockResolvedValueOnce([g]);
    const { result } = renderHook(() => useLectureAccess(LECTURE));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiGet).toHaveBeenCalledWith(`/lectures/${LECTURE}/access`);
    expect(result.current.grants).toEqual([g]);
  });

  it('lectureId null → запрос не уходит, grants=[]', async () => {
    const { result } = renderHook(() => useLectureAccess(null));
    expect(apiGet).not.toHaveBeenCalled();
    expect(result.current.grants).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('401 → error=forbidden; 404 → not-found; прочее → load-failed', async () => {
    apiGet.mockRejectedValueOnce(new ApiError('Forbidden', undefined, 403));
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useLectureAccess(id),
      { initialProps: { id: 'L1' } },
    );
    await waitFor(() => expect(result.current.error).toBe('forbidden'));

    apiGet.mockRejectedValueOnce(new ApiError('Not Found', undefined, 404));
    rerender({ id: 'L2' });
    await waitFor(() => expect(result.current.error).toBe('not-found'));

    apiGet.mockRejectedValueOnce(new Error('boom'));
    rerender({ id: 'L3' });
    await waitFor(() => expect(result.current.error).toBe('load-failed'));
  });

  it('grantUser: оптимистичная вставка + замена на ответ backend', async () => {
    apiGet.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useLectureAccess(LECTURE));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const created = makeGrant('g-real', 'u-new', 'newuser');
    let resolvePost: (v: unknown) => void = () => {};
    apiPost.mockReturnValueOnce(
      new Promise((res) => {
        resolvePost = res;
      }),
    );

    let pendingId = '';
    await act(async () => {
      void result.current.grantUser('u-new');
      // Микротик, чтобы оптимистичная вставка успела попасть в state.
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.grants).toHaveLength(1);
    pendingId = result.current.grants[0].grant.id;
    expect(pendingId.startsWith('pending-')).toBe(true);

    await act(async () => {
      resolvePost(created);
    });
    await waitFor(() => {
      const g = result.current.grants[0];
      return g.grant.id === 'g-real';
    });
    expect(result.current.grants[0]).toEqual(created);
    expect(result.current.lastMutationError).toBeNull();
  });

  it('grantUser ошибка: откат оптимистичной вставки + lastMutationError', async () => {
    apiGet.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useLectureAccess(LECTURE));
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiPost.mockRejectedValueOnce(
      new ApiError('Course access not supported', 'course_access_not_supported', 400),
    );
    await act(async () => {
      await result.current.grantUser('u-bad');
    });
    expect(result.current.grants).toEqual([]);
    expect(result.current.lastMutationError?.errorCode).toBe(
      'course_access_not_supported',
    );
  });

  it('revokeGrant: оптимистичное удаление + успех', async () => {
    const g = makeGrant('g1', 'u1');
    apiGet.mockResolvedValueOnce([g]);
    const { result } = renderHook(() => useLectureAccess(LECTURE));
    await waitFor(() => expect(result.current.grants).toHaveLength(1));

    apiDelete.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.revokeGrant('g1');
    });
    expect(result.current.grants).toEqual([]);
    expect(apiDelete).toHaveBeenCalledWith(`/lectures/${LECTURE}/access/g1`);
  });

  it('revokeGrant ошибка: откат + lastMutationError', async () => {
    const g = makeGrant('g1', 'u1');
    apiGet.mockResolvedValueOnce([g]);
    const { result } = renderHook(() => useLectureAccess(LECTURE));
    await waitFor(() => expect(result.current.grants).toHaveLength(1));

    apiDelete.mockRejectedValueOnce(
      new ApiError('Forbidden', 'lecture_access_revoked', 403),
    );
    await act(async () => {
      await result.current.revokeGrant('g1');
    });
    // Откат — список снова с одной записью.
    expect(result.current.grants).toEqual([g]);
    expect(result.current.lastMutationError?.errorCode).toBe(
      'lecture_access_revoked',
    );
  });

  it('grantUser идемпотентен: второй вызов с тем же userId — no-op', async () => {
    const existing = makeGrant('g1', 'u1');
    apiGet.mockResolvedValueOnce([existing]);
    const { result } = renderHook(() => useLectureAccess(LECTURE));
    await waitFor(() => expect(result.current.grants).toHaveLength(1));

    await act(async () => {
      await result.current.grantUser('u1');
    });
    expect(apiPost).not.toHaveBeenCalled();
    expect(result.current.grants).toEqual([existing]);
  });

  it('refetch повторяет GET с тем же lectureId', async () => {
    apiGet.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useLectureAccess(LECTURE));
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiGet.mockResolvedValueOnce([makeGrant('g1', 'u1')]);
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.grants).toHaveLength(1));
    expect(apiGet).toHaveBeenCalledTimes(2);
  });
});
