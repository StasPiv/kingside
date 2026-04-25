import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useDelayedFlag } from './useDelayedFlag';

/**
 * KS-1924: анти-flicker для skeleton-состояний.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDelayedFlag', () => {
  it('начинает с false', () => {
    const { result } = renderHook(() => useDelayedFlag(true, 200));
    expect(result.current).toBe(false);
  });

  it('поднимает true после задержки если active=true всё это время', () => {
    const { result } = renderHook(() => useDelayedFlag(true, 200));
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it('не поднимает true если active вернулся в false до истечения таймера', () => {
    const { result, rerender } = renderHook(
      ({ active }) => useDelayedFlag(active, 200),
      { initialProps: { active: true } },
    );
    act(() => {
      vi.advanceTimersByTime(150);
    });
    rerender({ active: false });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(false);
  });

  it('сбрасывает true если active позднее снова стал false', () => {
    const { result, rerender } = renderHook(
      ({ active }) => useDelayedFlag(active, 200),
      { initialProps: { active: true } },
    );
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current).toBe(true);
    rerender({ active: false });
    expect(result.current).toBe(false);
  });

  it('по умолчанию delay=200мс', () => {
    const { result } = renderHook(() => useDelayedFlag(true));
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });
});
