/**
 * KS-3970 / ADR-119 C01. Тесты `useUserSearch` с реальным
 * таймером и коротким `debounceMs`, чтобы не упираться в гонки
 * fake-timers ↔ waitFor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { ApiError } from '../ApiError';

const apiGet = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: (path: string) => apiGet(path),
  },
}));

import { useUserSearch } from './useUserSearch';

const ALICE = { id: 'u1', username: 'alice', displayName: 'Alice' };
const BOB = { id: 'u2', username: 'bob', displayName: 'Bob' };

beforeEach(() => {
  apiGet.mockReset();
});

describe('useUserSearch KS-3970', () => {
  it('query короче minLength → запрос не уходит, results пустой', async () => {
    const { result } = renderHook(() =>
      useUserSearch('a', { debounceMs: 5 }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(apiGet).not.toHaveBeenCalled();
    expect(result.current.results).toEqual([]);
  });

  it('после debounce запрос уходит с правильным query', async () => {
    apiGet.mockResolvedValueOnce([ALICE]);
    const { result } = renderHook(() =>
      useUserSearch('al', { debounceMs: 5 }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    expect(apiGet.mock.calls[0][0]).toContain('/users/search?');
    expect(apiGet.mock.calls[0][0]).toContain('q=al');
    expect(apiGet.mock.calls[0][0]).toContain('limit=8');
    await waitFor(() => expect(result.current.results).toEqual([ALICE]));
  });

  it('смена q отменяет результат прошлого запроса', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    apiGet.mockReturnValueOnce(
      new Promise((res) => {
        resolveFirst = res;
      }),
    );
    apiGet.mockResolvedValueOnce([BOB]);

    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useUserSearch(q, { debounceMs: 5 }),
      { initialProps: { q: 'al' } },
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));

    rerender({ q: 'bob' });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));

    // Резолвим устаревший первый запрос — он не должен подменить
    // только что полученный 'bob'-список.
    resolveFirst([ALICE]);
    await new Promise((r) => setTimeout(r, 30));
    await waitFor(() => expect(result.current.results).toEqual([BOB]));
  });

  it('403 → error=forbidden', async () => {
    apiGet.mockRejectedValueOnce(new ApiError('Forbidden', undefined, 403));
    const { result } = renderHook(() =>
      useUserSearch('al', { debounceMs: 5 }),
    );
    await waitFor(() => expect(result.current.error).toBe('forbidden'));
    expect(result.current.results).toEqual([]);
  });

  it('5xx / прочее → error=load-failed', async () => {
    apiGet.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() =>
      useUserSearch('al', { debounceMs: 5 }),
    );
    await waitFor(() => expect(result.current.error).toBe('load-failed'));
  });

  it('пробелы триммируются: "  a  " ниже minLength', async () => {
    const { result } = renderHook(() =>
      useUserSearch('  a  ', { debounceMs: 5 }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(apiGet).not.toHaveBeenCalled();
    expect(result.current.query).toBe('a');
  });
});
