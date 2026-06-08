/**
 * KS-3966 / ADR-119 §8 эпик B (B01). Тесты `useMyLectures`.
 *
 * Покрытие:
 *  - первичный запрос с правильным query;
 *  - смена фильтра `status` сбрасывает items и заново запрашивает;
 *  - `loadMore` конкатенирует следующую страницу, корректно считает
 *    `offset` по уже загруженным items;
 *  - `loadMore` no-op при `hasMore=false`;
 *  - 401/403 → `error: 'forbidden'`, 404 → `'not-found'`, прочее →
 *    `'load-failed'`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ApiError } from '../ApiError';

const apiGet = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: (path: string) => apiGet(path),
  },
}));

import { useMyLectures } from './useMyLectures';

function makeSummary(id: string, status: 'live' | 'scheduled' | 'recorded' | 'cancelled' = 'recorded') {
  return {
    id,
    ownerId: 'u-1',
    title: `Lecture ${id}`,
    description: null,
    scheduledAt: null,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    status,
    visibility: 'public' as const,
    liveAnalysisId: null,
    recordingId: null,
    mediaUrl: null,
    mediaKind: null,
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    liveAnalysis: null,
    disabledTools: [],
  };
}

beforeEach(() => {
  apiGet.mockReset();
});

describe('useMyLectures KS-3966', () => {
  it('первичный запрос: GET /my/lectures?limit=20&offset=0 без status', async () => {
    apiGet.mockResolvedValueOnce({
      items: [makeSummary('a'), makeSummary('b')],
      total: 2,
      hasMore: false,
    });
    const { result } = renderHook(() => useMyLectures());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiGet).toHaveBeenCalledWith('/my/lectures?limit=20&offset=0');
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(result.current.total).toBe(2);
    expect(result.current.hasMore).toBe(false);
  });

  it('фильтр status передаётся в query, кроме "all"', async () => {
    apiGet.mockResolvedValueOnce({ items: [], total: 0, hasMore: false });
    const { rerender } = renderHook(
      ({ status }: { status?: 'live' | 'all' }) =>
        useMyLectures({ status }),
      { initialProps: { status: 'live' } },
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(apiGet.mock.calls[0][0]).toBe(
      '/my/lectures?limit=20&offset=0&status=live',
    );

    apiGet.mockResolvedValueOnce({ items: [], total: 0, hasMore: false });
    rerender({ status: 'all' });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(apiGet.mock.calls[1][0]).toBe('/my/lectures?limit=20&offset=0');
  });

  it('смена status сбрасывает items и заново запрашивает', async () => {
    apiGet.mockResolvedValueOnce({
      items: [makeSummary('x', 'live')],
      total: 1,
      hasMore: false,
    });
    const { result, rerender } = renderHook(
      ({ status }: { status?: 'live' | 'recorded' }) =>
        useMyLectures({ status }),
      { initialProps: { status: 'live' } },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    apiGet.mockResolvedValueOnce({
      items: [makeSummary('y', 'recorded')],
      total: 1,
      hasMore: false,
    });
    rerender({ status: 'recorded' });
    // Сразу после смены фильтра items должны быть сброшены до прихода ответа.
    await waitFor(() =>
      expect(result.current.items.map((i) => i.id)).toEqual(['y']),
    );
  });

  it('loadMore: конкатенирует страницу 2 и считает offset', async () => {
    apiGet.mockResolvedValueOnce({
      items: [makeSummary('a'), makeSummary('b')],
      total: 4,
      hasMore: true,
    });
    const { result } = renderHook(() => useMyLectures({ limit: 2 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);

    apiGet.mockResolvedValueOnce({
      items: [makeSummary('c'), makeSummary('d')],
      total: 4,
      hasMore: false,
    });
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.items.map((i) => i.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(result.current.hasMore).toBe(false);
    expect(apiGet.mock.calls[1][0]).toBe('/my/lectures?limit=2&offset=2');
  });

  it('loadMore: no-op при hasMore=false', async () => {
    apiGet.mockResolvedValueOnce({
      items: [makeSummary('a')],
      total: 1,
      hasMore: false,
    });
    const { result } = renderHook(() => useMyLectures());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const callsBefore = apiGet.mock.calls.length;
    act(() => result.current.loadMore());
    // Никакого нового запроса не отправилось.
    expect(apiGet.mock.calls.length).toBe(callsBefore);
  });

  it('401 → error: forbidden', async () => {
    apiGet.mockRejectedValueOnce(new ApiError('Unauthorized', undefined, 401));
    const { result } = renderHook(() => useMyLectures());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('forbidden');
    expect(result.current.items).toEqual([]);
  });

  it('404 → error: not-found', async () => {
    apiGet.mockRejectedValueOnce(new ApiError('Not Found', undefined, 404));
    const { result } = renderHook(() => useMyLectures());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('not-found');
  });

  it('5xx / прочее → error: load-failed', async () => {
    apiGet.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useMyLectures());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('load-failed');
  });

  it('refetch инициирует новый запрос с тем же фильтром', async () => {
    apiGet.mockResolvedValueOnce({
      items: [makeSummary('a')],
      total: 1,
      hasMore: false,
    });
    const { result } = renderHook(() => useMyLectures());
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiGet.mockResolvedValueOnce({
      items: [makeSummary('a'), makeSummary('b')],
      total: 2,
      hasMore: false,
    });
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(apiGet.mock.calls.length).toBe(2);
  });
});
