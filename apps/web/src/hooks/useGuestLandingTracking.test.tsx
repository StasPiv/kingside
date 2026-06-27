// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGuestLandingTracking } from './useGuestLandingTracking';
import * as eventsModule from '../lib/events';

describe('useGuestLandingTracking (KS-4684)', () => {
  let trackSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    trackSpy = vi.spyOn(eventsModule, 'track').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    trackSpy.mockRestore();
  });

  it('disabled=true — никаких событий', () => {
    const { unmount } = renderHook(() => useGuestLandingTracking({ disabled: true }));
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    unmount();
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('тикает каждые tickSec секунд', () => {
    renderHook(() => useGuestLandingTracking({ tickSec: 30 }));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith('guest_landing_viewed', { seconds: 30 });

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(trackSpy).toHaveBeenCalledTimes(2);
    expect(trackSpy).toHaveBeenLastCalledWith('guest_landing_viewed', { seconds: 60 });
  });

  it('на unmount шлёт финальное событие с накопленным временем', () => {
    const { unmount } = renderHook(() => useGuestLandingTracking({ tickSec: 30 }));
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    unmount();
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith('guest_landing_viewed', { seconds: 15 });
  });
});
