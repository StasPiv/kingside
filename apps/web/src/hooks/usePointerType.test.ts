import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { usePointerType } from './usePointerType';

/**
 * KS-2841 (ADR-058 §11.2, §11.7): тестируем что хук:
 *   - возвращает `fine`/`coarse` по `matchMedia('(pointer: fine)').matches`;
 *   - реагирует на listener `change` (подключение мыши → fine);
 *   - чистит listener при unmount.
 */

interface FakeMQL {
  matches: boolean;
  media: string;
  addEventListener: (event: 'change', fn: (e: MediaQueryListEvent) => void) => void;
  removeEventListener: (event: 'change', fn: (e: MediaQueryListEvent) => void) => void;
  fire: (matches: boolean) => void;
  listeners: Array<(e: MediaQueryListEvent) => void>;
}

function makeMql(initial: boolean): FakeMQL {
  const m: FakeMQL = {
    matches: initial,
    media: '(pointer: fine)',
    listeners: [],
    addEventListener: (_e, fn) => {
      m.listeners.push(fn);
    },
    removeEventListener: (_e, fn) => {
      m.listeners = m.listeners.filter((l) => l !== fn);
    },
    fire: (matches: boolean) => {
      m.matches = matches;
      for (const l of m.listeners) {
        l({ matches } as MediaQueryListEvent);
      }
    },
  };
  return m;
}

let mql: FakeMQL;
const originalMM = window.matchMedia;

beforeEach(() => {
  mql = makeMql(true);
  (window as unknown as { matchMedia: (q: string) => FakeMQL }).matchMedia = (
    q: string,
  ) => {
    expect(q).toBe('(pointer: fine)');
    return mql;
  };
});

afterEach(() => {
  window.matchMedia = originalMM;
});

describe('usePointerType', () => {
  it('initial matches=true → `fine`', () => {
    const { result } = renderHook(() => usePointerType());
    expect(result.current).toBe('fine');
  });

  it('initial matches=false → `coarse`', () => {
    mql.matches = false;
    const { result } = renderHook(() => usePointerType());
    expect(result.current).toBe('coarse');
  });

  it('reagирует на change: coarse → fine при подключении мыши', () => {
    mql.matches = false;
    const { result } = renderHook(() => usePointerType());
    expect(result.current).toBe('coarse');
    act(() => mql.fire(true));
    expect(result.current).toBe('fine');
  });

  it('reagирует на change: fine → coarse при отключении мыши', () => {
    mql.matches = true;
    const { result } = renderHook(() => usePointerType());
    expect(result.current).toBe('fine');
    act(() => mql.fire(false));
    expect(result.current).toBe('coarse');
  });

  it('cleanup: после unmount listener снимается', () => {
    const { unmount } = renderHook(() => usePointerType());
    expect(mql.listeners.length).toBe(1);
    unmount();
    expect(mql.listeners.length).toBe(0);
  });
});
