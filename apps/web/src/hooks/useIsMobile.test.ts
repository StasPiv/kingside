import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useIsMobile } from './useIsMobile';

/**
 * KS-2278 — детект mobile = touch + узкий viewport (AND).
 *
 * Поведение:
 *  - touch=true + width<=768 → mobile
 *  - touch=true + width>768  → desktop (touch-screen ноут)
 *  - touch=false + width<=768 → desktop (узкое окно браузера)
 *  - touch=false + width>768 → desktop
 *  - resize / orientationchange → re-detect.
 */

interface OriginalEnv {
  innerWidth: number;
  maxTouchPoints: number;
}

let original: OriginalEnv;

function setEnv(opts: { width: number; touch: number }) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: opts.width,
  });
  Object.defineProperty(navigator, 'maxTouchPoints', {
    configurable: true,
    value: opts.touch,
  });
}

beforeEach(() => {
  original = {
    innerWidth: window.innerWidth,
    maxTouchPoints: navigator.maxTouchPoints,
  };
});

afterEach(() => {
  setEnv({ width: original.innerWidth, touch: original.maxTouchPoints });
});

describe('useIsMobile (KS-2278)', () => {
  it('touch + узкий viewport (375x812 как iPhone) → true', () => {
    setEnv({ width: 375, touch: 5 });
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('touch + широкий viewport (touch-screen ноут 1280x800) → false', () => {
    setEnv({ width: 1280, touch: 10 });
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('no touch + узкий viewport (узкое окно desktop 600px) → false', () => {
    setEnv({ width: 600, touch: 0 });
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('no touch + широкий viewport → false (default desktop)', () => {
    setEnv({ width: 1920, touch: 0 });
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('resize переключает значение (rotate iPad portrait→landscape)', () => {
    setEnv({ width: 768, touch: 5 });
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);

    act(() => {
      setEnv({ width: 1024, touch: 5 });
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toBe(false);
  });

  it('orientationchange тоже триггерит re-detect', () => {
    setEnv({ width: 1024, touch: 5 });
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => {
      setEnv({ width: 700, touch: 5 });
      window.dispatchEvent(new Event('orientationchange'));
    });
    expect(result.current).toBe(true);
  });

  it('кастомный breakpoint работает', () => {
    setEnv({ width: 600, touch: 5 });
    // breakpoint=500 → 600 > 500 → desktop
    const { result } = renderHook(() => useIsMobile({ breakpointPx: 500 }));
    expect(result.current).toBe(false);
  });
});
