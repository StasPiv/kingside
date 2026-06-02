/**
 * KS-3593. Тесты `useEngineSortMode` — init из localStorage, валидация,
 * setter с записью.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  useEngineSortMode,
  ENGINE_SORT_INTERNAL,
} from './useEngineSortMode';

beforeEach(() => {
  localStorage.clear();
});

describe('useEngineSortMode (KS-3593)', () => {
  it('init: пустой localStorage → stockfish', () => {
    const { result } = renderHook(() => useEngineSortMode());
    expect(result.current.sortMode).toBe('stockfish');
  });

  it('init: ключ "maia" → maia', () => {
    localStorage.setItem(ENGINE_SORT_INTERNAL.STORAGE_KEY, 'maia');
    const { result } = renderHook(() => useEngineSortMode());
    expect(result.current.sortMode).toBe('maia');
  });

  it('init: ключ "stockfish" → stockfish', () => {
    localStorage.setItem(ENGINE_SORT_INTERNAL.STORAGE_KEY, 'stockfish');
    const { result } = renderHook(() => useEngineSortMode());
    expect(result.current.sortMode).toBe('stockfish');
  });

  it('init: мусор в localStorage → stockfish', () => {
    localStorage.setItem(ENGINE_SORT_INTERNAL.STORAGE_KEY, 'gibberish');
    const { result } = renderHook(() => useEngineSortMode());
    expect(result.current.sortMode).toBe('stockfish');
  });

  it('setSortMode записывает в localStorage и обновляет state', () => {
    const { result } = renderHook(() => useEngineSortMode());
    act(() => result.current.setSortMode('maia'));
    expect(result.current.sortMode).toBe('maia');
    expect(localStorage.getItem(ENGINE_SORT_INTERNAL.STORAGE_KEY)).toBe('maia');

    act(() => result.current.setSortMode('stockfish'));
    expect(result.current.sortMode).toBe('stockfish');
    expect(localStorage.getItem(ENGINE_SORT_INTERNAL.STORAGE_KEY)).toBe(
      'stockfish',
    );
  });

  it('повторный setSortMode тем же значением не вызывает лишних записей', () => {
    const { result } = renderHook(() => useEngineSortMode());
    act(() => result.current.setSortMode('maia'));
    localStorage.clear();
    act(() => result.current.setSortMode('maia')); // тот же
    // По прежнему пусто — second setSortMode не должен был писать.
    expect(localStorage.getItem(ENGINE_SORT_INTERNAL.STORAGE_KEY)).toBeNull();
  });
});
