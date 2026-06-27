// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useIdleTracking } from './useIdleTracking';
import * as eventsModule from '../lib/events';

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/play']}>{children}</MemoryRouter>;
}

describe('useIdleTracking (KS-4684)', () => {
  let trackSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    trackSpy = vi.spyOn(eventsModule, 'track').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    trackSpy.mockRestore();
  });

  it('первое session_idle через idleSec секунд бездействия', () => {
    renderHook(() => useIdleTracking({ idleSec: 30, repeatSec: 60 }), { wrapper });
    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(trackSpy).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith('session_idle', {
      page: '/play',
      idle_seconds: 30,
    });
  });

  it('повторные события каждые repeatSec секунд', () => {
    renderHook(() => useIdleTracking({ idleSec: 30, repeatSec: 60 }), { wrapper });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(trackSpy).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(trackSpy).toHaveBeenCalledTimes(2);
    expect(trackSpy).toHaveBeenLastCalledWith('session_idle', {
      page: '/play',
      idle_seconds: 90,
    });

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(trackSpy).toHaveBeenCalledTimes(3);
  });

  it('активность сбрасывает таймер', () => {
    renderHook(() => useIdleTracking({ idleSec: 30, repeatSec: 60 }), { wrapper });

    act(() => {
      vi.advanceTimersByTime(25_000);
    });
    expect(trackSpy).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new Event('mousemove'));
    });

    // Прошло 25 сек до активности — таймер должен начаться заново.
    act(() => {
      vi.advanceTimersByTime(25_000);
    });
    expect(trackSpy).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(trackSpy).toHaveBeenCalledTimes(1);
  });

  it('cleanup снимает таймеры и листенеры', () => {
    const { unmount } = renderHook(() => useIdleTracking(), { wrapper });
    unmount();
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(trackSpy).not.toHaveBeenCalled();
  });
});
