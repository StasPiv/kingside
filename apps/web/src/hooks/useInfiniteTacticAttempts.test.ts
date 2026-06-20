/**
 * KS-4359 / ADR-136 §3.8. Тесты `useInfiniteTacticAttempts` —
 * cursor-пагинация и фильтры для `GET /tactic-puzzles/attempts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiGet = vi.fn();
vi.mock('../api', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}));

import { useInfiniteTacticAttempts } from './useInfiniteTacticAttempts';
import type { TacticAttemptListItem } from '@kingside/shared';

const ATTEMPT_A: TacticAttemptListItem = {
  id: 'a',
  puzzleId: 'p1',
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  bestMoveUci: 'e2e4',
  solverSide: 'w',
  objective: 'convertAdvantage',
  playersTitle: 'Carlsen vs Nepo',
  solved: true,
  stopReason: 'easy',
  lineHalfMoves: 3,
  timeMs: 10500,
  ratingBefore: 1500,
  ratingAfter: 1512,
  ratingDelta: 12,
  precisionGrade: 5,
  createdAt: '2026-06-20T07:10:00Z',
};
const ATTEMPT_B: TacticAttemptListItem = { ...ATTEMPT_A, id: 'b' };
const ATTEMPT_C: TacticAttemptListItem = { ...ATTEMPT_A, id: 'c' };

function attemptCalls(): unknown[][] {
  return apiGet.mock.calls.filter(
    (c) =>
      typeof c[0] === 'string' &&
      (c[0] as string).startsWith('/tactic-puzzles/attempts'),
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation(() =>
    Promise.resolve({ items: [], nextCursor: null }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useInfiniteTacticAttempts', () => {
  it('первичный запрос загружает первую страницу', async () => {
    apiGet.mockResolvedValueOnce({
      items: [ATTEMPT_A, ATTEMPT_B],
      nextCursor: 'cur1',
    });
    const { result } = renderHook(() =>
      useInfiniteTacticAttempts({ limit: 2 }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.attempts.map((a) => a.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(true);
    expect(attemptCalls()[0][0]).toBe('/tactic-puzzles/attempts?limit=2');
  });

  it('loadMore догружает следующую страницу с cursor', async () => {
    apiGet.mockResolvedValueOnce({ items: [ATTEMPT_A], nextCursor: 'cur1' });
    const { result } = renderHook(() =>
      useInfiniteTacticAttempts({ limit: 1 }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiGet.mockResolvedValueOnce({ items: [ATTEMPT_B], nextCursor: null });
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.attempts.map((a) => a.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(false);
    expect(attemptCalls()[1][0]).toBe(
      '/tactic-puzzles/attempts?limit=1&cursor=cur1',
    );
  });

  it('передаёт фильтры в query', async () => {
    apiGet.mockResolvedValueOnce({ items: [], nextCursor: null });
    renderHook(() =>
      useInfiniteTacticAttempts({
        from: '2026-06-01T00:00:00Z',
        to: '2026-06-20T23:59:59Z',
        stopReason: 'mistake',
        solved: false,
        ratingMin: 1200,
        ratingMax: 1800,
        limit: 30,
      }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = apiGet.mock.calls[0][0] as string;
    expect(url).toMatch(/limit=30/);
    expect(url).toMatch(/from=2026-06-01/);
    expect(url).toMatch(/to=2026-06-20/);
    expect(url).toMatch(/stopReason=mistake/);
    expect(url).toMatch(/solved=false/);
    expect(url).toMatch(/ratingMin=1200/);
    expect(url).toMatch(/ratingMax=1800/);
  });

  it('solved=true передаётся как строка', async () => {
    apiGet.mockResolvedValueOnce({ items: [], nextCursor: null });
    renderHook(() =>
      useInfiniteTacticAttempts({ solved: true, limit: 10 }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(apiGet.mock.calls[0][0] as string).toMatch(/solved=true/);
  });

  it('смена фильтров → новый запрос без cursor (reset списка)', async () => {
    apiGet.mockResolvedValueOnce({ items: [ATTEMPT_A], nextCursor: 'cur1' });
    const { result, rerender } = renderHook(
      ({ stopReason }: { stopReason?: 'mistake' | 'easy' }) =>
        useInfiniteTacticAttempts({ stopReason }),
      { initialProps: { stopReason: 'easy' as const } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiGet.mockResolvedValueOnce({ items: [ATTEMPT_C], nextCursor: null });
    rerender({ stopReason: 'mistake' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.attempts.map((a) => a.id)).toEqual(['c']);
    expect(attemptCalls()[1][0]).toBe(
      '/tactic-puzzles/attempts?limit=30&stopReason=mistake',
    );
  });

  it('removeLocally и patchLocally', async () => {
    apiGet.mockResolvedValueOnce({
      items: [ATTEMPT_A, ATTEMPT_B],
      nextCursor: null,
    });
    const { result } = renderHook(() => useInfiniteTacticAttempts({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.removeLocally('a'));
    expect(result.current.attempts.map((a) => a.id)).toEqual(['b']);
    act(() => result.current.patchLocally('b', { ratingDelta: 99 }));
    expect(result.current.attempts[0].ratingDelta).toBe(99);
  });

  it('backend возвращает тот же cursor → hasMore=false', async () => {
    apiGet.mockResolvedValueOnce({ items: [ATTEMPT_A], nextCursor: 'cur1' });
    const { result } = renderHook(() => useInfiniteTacticAttempts({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    apiGet.mockResolvedValueOnce({ items: [ATTEMPT_B], nextCursor: 'cur1' });
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.hasMore).toBe(false);
  });

  it('error устанавливается при отказе API', async () => {
    apiGet.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useInfiniteTacticAttempts({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/boom/);
    expect(result.current.attempts).toEqual([]);
  });
});
