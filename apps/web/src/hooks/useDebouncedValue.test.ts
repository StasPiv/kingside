// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedValue } from './useDebouncedValue';

describe('useDebouncedValue (KS-3112)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('возвращает начальное значение сразу', () => {
    const { result } = renderHook(() => useDebouncedValue(1, 250));
    expect(result.current).toBe(1);
  });

  it('обновляется после delay', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedValue(v, 250),
      { initialProps: { v: 1 } },
    );
    rerender({ v: 2 });
    expect(result.current).toBe(1); // ещё не успел
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current).toBe(2);
  });

  it('повторные быстрые изменения = только финальное (debounce)', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedValue(v, 250),
      { initialProps: { v: 1 } },
    );
    // Симулируем 5 быстрых кликов «+» (1 → 2 → 3 → 4 → 5 → 6) подряд
    // за 100мс — типичный сценарий из жалобы KS-3112.
    rerender({ v: 2 });
    act(() => vi.advanceTimersByTime(50));
    rerender({ v: 3 });
    act(() => vi.advanceTimersByTime(50));
    rerender({ v: 4 });
    act(() => vi.advanceTimersByTime(50));
    rerender({ v: 5 });
    act(() => vi.advanceTimersByTime(50));
    rerender({ v: 6 });
    // К этому моменту таймеры по 2..5 были сброшены, активен только
    // последний на v=6. Текущее значение всё ещё 1 — debounce не прошёл.
    expect(result.current).toBe(1);
    act(() => vi.advanceTimersByTime(250));
    // Финальное значение применилось одной транзакцией.
    expect(result.current).toBe(6);
  });

  it('delay=0 — мгновенное обновление без таймера', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedValue(v, 0),
      { initialProps: { v: 1 } },
    );
    rerender({ v: 99 });
    // С delay=0 setDebounced вызывается синхронно в useEffect.
    expect(result.current).toBe(99);
  });
});
