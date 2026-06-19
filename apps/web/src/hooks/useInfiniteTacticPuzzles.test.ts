/**
 * KS-4343 / ADR-135 §2.5: тесты `useInfiniteTacticPuzzles`. Покрывают
 * cursor-pagination, race-guard, локальные операции (remove/patch) и
 * специфичные новой схеме фильтры (`objective`, `minDifficulty` /
 * `maxDifficulty`). Образец взят из `useInfinitePuzzles.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiGet = vi.fn();
vi.mock('../api', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}));

import { useInfiniteTacticPuzzles } from './useInfiniteTacticPuzzles';

const PUZZLE_A = {
  id: 'a',
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  bestMoveUci: 'e2e4',
  solverSide: 'w' as const,
  objective: 'convertAdvantage' as const,
  difficulty: 0.92,
  gap: 0.35,
  rating: 1500,
  themes: ['pin'],
  createdAt: '2026-06-19T10:00:00Z',
};
const PUZZLE_B = { ...PUZZLE_A, id: 'b' };
const PUZZLE_C = { ...PUZZLE_A, id: 'c' };

function browseCalls(): unknown[][] {
  return apiGet.mock.calls.filter(
    (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('/tactic-puzzles/browse'),
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation(() =>
    Promise.resolve({ data: [], nextCursor: null }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useInfiniteTacticPuzzles', () => {
  it('первичный fetch загружает первую страницу', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A, PUZZLE_B],
      nextCursor: 'cur1',
    });
    const { result } = renderHook(() =>
      useInfiniteTacticPuzzles({ limit: 2 }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(true);
    expect(browseCalls()[0][0]).toBe('/tactic-puzzles/browse?limit=2');
  });

  it('loadMore догружает следующую страницу с cursor', async () => {
    apiGet.mockResolvedValueOnce({ data: [PUZZLE_A], nextCursor: 'cur1' });
    const { result } = renderHook(() =>
      useInfiniteTacticPuzzles({ limit: 1 }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiGet.mockResolvedValueOnce({ data: [PUZZLE_B], nextCursor: null });
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(false);
    expect(browseCalls()[1][0]).toBe(
      '/tactic-puzzles/browse?limit=1&cursor=cur1',
    );
  });

  it('hasMore=false при nextCursor=null с первого ответа', async () => {
    apiGet.mockResolvedValueOnce({ data: [PUZZLE_A], nextCursor: null });
    const { result } = renderHook(() => useInfiniteTacticPuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(false);
  });

  it('передаёт фильтры в query (themes ANY-of через запятую, objective)', async () => {
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    renderHook(() =>
      useInfiniteTacticPuzzles({
        ratingMin: 1200,
        ratingMax: 1800,
        themes: ['pin', 'fork'],
        objective: 'convertAdvantage',
        mine: true,
        hideSolved: true,
        limit: 30,
      }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = apiGet.mock.calls[0][0] as string;
    expect(url).toMatch(/limit=30/);
    expect(url).toMatch(/ratingMin=1200/);
    expect(url).toMatch(/ratingMax=1800/);
    expect(url).toMatch(/themes=pin%2Cfork|themes=pin,fork/);
    expect(url).toMatch(/objective=convertAdvantage/);
    expect(url).toMatch(/mine=true/);
    expect(url).toMatch(/hideSolved=true/);
  });

  it('objective=all → параметр НЕ передаётся', async () => {
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    renderHook(() =>
      useInfiniteTacticPuzzles({ objective: 'all', limit: 10 }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = apiGet.mock.calls[0][0] as string;
    expect(url).not.toMatch(/objective=/);
  });

  it('minDifficulty > 0 → передаётся; minDifficulty=0 → НЕ передаётся', async () => {
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    const { rerender } = renderHook(
      ({ min }: { min: number }) =>
        useInfiniteTacticPuzzles({ minDifficulty: min, limit: 10 }),
      { initialProps: { min: 0.5 } },
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(apiGet.mock.calls[0][0] as string).toMatch(/minDifficulty=0\.5/);

    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    rerender({ min: 0 });
    await waitFor(() => expect(browseCalls()).toHaveLength(2));
    expect(browseCalls()[1][0] as string).not.toMatch(/minDifficulty/);
  });

  it('maxDifficulty < 1 → передаётся; maxDifficulty=1 → НЕ передаётся', async () => {
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    const { rerender } = renderHook(
      ({ max }: { max: number }) =>
        useInfiniteTacticPuzzles({ maxDifficulty: max, limit: 10 }),
      { initialProps: { max: 0.8 } },
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(apiGet.mock.calls[0][0] as string).toMatch(/maxDifficulty=0\.8/);

    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    rerender({ max: 1 });
    await waitFor(() => expect(browseCalls()).toHaveLength(2));
    expect(browseCalls()[1][0] as string).not.toMatch(/maxDifficulty/);
  });

  it('смена фильтров → новый запрос без cursor (reset списка)', async () => {
    apiGet.mockResolvedValueOnce({ data: [PUZZLE_A], nextCursor: 'cur1' });
    const { result, rerender } = renderHook(
      ({ ratingMin }: { ratingMin: number }) =>
        useInfiniteTacticPuzzles({ ratingMin }),
      { initialProps: { ratingMin: 1000 } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiGet.mockResolvedValueOnce({ data: [PUZZLE_C], nextCursor: null });
    rerender({ ratingMin: 2000 });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['c']);
    expect(browseCalls()[1][0]).toBe(
      '/tactic-puzzles/browse?limit=30&ratingMin=2000',
    );
  });

  it('removeLocally удаляет пазл из state', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A, PUZZLE_B],
      nextCursor: null,
    });
    const { result } = renderHook(() => useInfiniteTacticPuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.removeLocally('a'));
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['b']);
  });

  it('patchLocally обновляет одно поле пазла', async () => {
    apiGet.mockResolvedValueOnce({ data: [PUZZLE_A], nextCursor: null });
    const { result } = renderHook(() => useInfiniteTacticPuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.patchLocally('a', { solvedStatus: 'solved' }));
    expect(result.current.puzzles[0].solvedStatus).toBe('solved');
  });

  it('backend возвращает тот же cursor → hasMore=false (защита от цикла)', async () => {
    apiGet.mockResolvedValueOnce({ data: [PUZZLE_A], nextCursor: 'cur1' });
    const { result } = renderHook(() => useInfiniteTacticPuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    apiGet.mockResolvedValueOnce({ data: [PUZZLE_B], nextCursor: 'cur1' });
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.hasMore).toBe(false);
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('двойной loadMore синхронно → только один сетевой запрос', async () => {
    apiGet.mockResolvedValueOnce({ data: [PUZZLE_A], nextCursor: 'cur1' });
    const { result } = renderHook(() => useInfiniteTacticPuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiGet.mockResolvedValueOnce({ data: [PUZZLE_B], nextCursor: 'cur2' });
    act(() => {
      result.current.loadMore();
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(browseCalls()).toHaveLength(2);
  });

  it('error устанавливается при отказе API', async () => {
    apiGet.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useInfiniteTacticPuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/boom/);
    expect(result.current.puzzles).toEqual([]);
  });

  it('смена filtersKey пока loadMore inflight сбрасывает loadingMore', async () => {
    apiGet.mockResolvedValueOnce({ data: [PUZZLE_A], nextCursor: 'cur1' });
    const { result, rerender } = renderHook(
      ({ themes }: { themes?: string[] }) =>
        useInfiniteTacticPuzzles({ themes }),
      { initialProps: {} as { themes?: string[] } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    let resolveSlow: (v: unknown) => void = () => {};
    apiGet.mockReturnValueOnce(
      new Promise((res) => {
        resolveSlow = res;
      }),
    );
    act(() => {
      result.current.loadMore();
    });
    expect(result.current.loadingMore).toBe(true);

    apiGet.mockResolvedValueOnce({ data: [PUZZLE_C], nextCursor: 'cur2' });
    rerender({ themes: ['pin'] });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['c']);

    // Поздний ответ старого запроса не должен затирать новый список.
    act(() => {
      resolveSlow({ data: [PUZZLE_B], nextCursor: 'old-cur' });
    });
    await waitFor(() =>
      expect(result.current.puzzles.map((p) => p.id)).toEqual(['c']),
    );
  });
});
