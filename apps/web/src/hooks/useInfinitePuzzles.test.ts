/**
 * KS-2561: тесты `useInfinitePuzzles`. Проверяем cursor pagination,
 * race-guard на смене фильтров, локальные операции (remove/patch).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiGet = vi.fn();
vi.mock('../api', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}));

import { useInfinitePuzzles } from './useInfinitePuzzles';

const PUZZLE_A = {
  id: 'a',
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  moves: ['e2e4'],
  rating: 1500,
  themes: ['mateIn1'],
  source: 'lichess',
  sourceId: null,
  sourceMoveNum: null,
  sourceMetadata: null,
  createdAt: '2026-05-07T10:00:00Z',
};
const PUZZLE_B = { ...PUZZLE_A, id: 'b' };
const PUZZLE_C = { ...PUZZLE_A, id: 'c' };

beforeEach(() => {
  apiGet.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useInfinitePuzzles KS-2561', () => {
  it('первичный fetch загружает первую страницу', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A, PUZZLE_B],
      nextCursor: 'cur1',
    });
    const { result } = renderHook(() => useInfinitePuzzles({ limit: 2 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(true);
    expect(apiGet).toHaveBeenCalledWith('/puzzles/browse?limit=2');
  });

  it('loadMore догружает следующую страницу с cursor', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: 'cur1',
    });
    const { result } = renderHook(() => useInfinitePuzzles({ limit: 1 }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_B],
      nextCursor: null,
    });
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(false);
    expect(apiGet).toHaveBeenLastCalledWith(
      '/puzzles/browse?limit=1&cursor=cur1',
    );
  });

  it('hasMore=false при nextCursor=null с первого ответа', async () => {
    apiGet.mockResolvedValueOnce({ data: [PUZZLE_A], nextCursor: null });
    const { result } = renderHook(() => useInfinitePuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(false);
  });

  it('передаёт фильтры в query (themes ANY-of через запятую)', async () => {
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    renderHook(() =>
      useInfinitePuzzles({
        ratingMin: 1200,
        ratingMax: 1800,
        themes: ['mateIn1', 'fork'],
        mine: true,
        hideSolved: true,
        source: 'lichess',
        limit: 30,
      }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = apiGet.mock.calls[0][0] as string;
    expect(url).toMatch(/limit=30/);
    expect(url).toMatch(/ratingMin=1200/);
    expect(url).toMatch(/ratingMax=1800/);
    expect(url).toMatch(/themes=mateIn1%2Cfork|themes=mateIn1,fork/);
    expect(url).toMatch(/mine=true/);
    expect(url).toMatch(/hideSolved=true/);
    expect(url).toMatch(/source=lichess/);
  });

  it('смена фильтров → новый запрос без cursor (reset)', async () => {
    apiGet.mockResolvedValueOnce({ data: [PUZZLE_A], nextCursor: 'cur1' });
    const { result, rerender } = renderHook(
      ({ filters }: { filters: Parameters<typeof useInfinitePuzzles>[0] }) =>
        useInfinitePuzzles(filters),
      { initialProps: { filters: { ratingMin: 1000 } } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiGet.mockResolvedValueOnce({ data: [PUZZLE_C], nextCursor: null });
    rerender({ filters: { ratingMin: 2000 } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Список заменён, не дополнен (reset).
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['c']);
    expect(apiGet.mock.calls[1][0]).toBe(
      '/puzzles/browse?limit=30&ratingMin=2000',
    );
  });

  it('removeLocally удаляет пазл из state', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A, PUZZLE_B],
      nextCursor: null,
    });
    const { result } = renderHook(() => useInfinitePuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.removeLocally('a'));
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['b']);
  });

  it('patchLocally обновляет одно поле пазла', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: null,
    });
    const { result } = renderHook(() => useInfinitePuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.patchLocally('a', { isPublic: true }));
    expect(result.current.puzzles[0].isPublic).toBe(true);
  });

  it('error устанавливается при отказе API', async () => {
    apiGet.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useInfinitePuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/boom/);
    expect(result.current.puzzles).toEqual([]);
  });
});
