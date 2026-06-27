// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useHintPull } from './useHintPull';
import type { HintShowPayload } from '@kingside/shared';

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/']}>{children}</MemoryRouter>;
}

const samplePayload: HintShowPayload = {
  hintId: '11111111-1111-1111-1111-111111111111',
  key: 'guest-register-prompt',
  locale: 'en',
  title: 'Sign up',
  body: 'Save your progress.',
  ctaLabel: 'Register',
  ctaHref: '/register',
  ctaEvent: null,
  anchor: 'landing-signup-button',
  placement: 'bottom',
  ttlSec: 0,
};

describe('useHintPull (KS-4703)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('enabled=false — fetch не зовётся', () => {
    const fetchImpl = vi.fn();
    const onHint = vi.fn();
    renderHook(() => useHintPull({ enabled: false, onHint, fetchImpl }), {
      wrapper,
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onHint).not.toHaveBeenCalled();
  });

  it('enabled=true — сразу первый pull + каждые 15 сек', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderHook(() => useHintPull({ enabled: true, onHint: vi.fn(), fetchImpl }), {
      wrapper,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // На 15с — обязательный interval-pull (как минимум). Может прибавиться
    // idle-pull, если резет таймера не успел произойти из-за активности.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('payload → onHint вызван', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([samplePayload]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const onHint = vi.fn();
    renderHook(() => useHintPull({ enabled: true, onHint, fetchImpl }), {
      wrapper,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onHint).toHaveBeenCalledWith(samplePayload);
  });

  it('idle 30 сек — внеочередной pull', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderHook(() => useHintPull({ enabled: true, onHint: vi.fn(), fetchImpl }), {
      wrapper,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const baseline = fetchImpl.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // За 30 сек: 2 interval-pull'а (на 15 и 30) + 1 idle-pull (на 30).
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(baseline + 1);
  });

  it('переход enabled=false → fetch перестаёт идти', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { rerender } = renderHook(
      ({ enabled }) =>
        useHintPull({ enabled, onHint: vi.fn(), fetchImpl }),
      { wrapper, initialProps: { enabled: true } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchImpl).toHaveBeenCalled();

    fetchImpl.mockClear();
    rerender({ enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
