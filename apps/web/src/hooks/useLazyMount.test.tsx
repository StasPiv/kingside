import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useEffect } from 'react';

import { useLazyMount } from './useLazyMount';

/**
 * KS-1924: lazy mount через IntersectionObserver.
 */

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit | undefined;
  target: Element | null = null;
  disconnected = false;

  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = cb;
    this.options = options;
    MockIntersectionObserver.instances.push(this);
  }

  observe(target: Element) {
    this.target = target;
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  root: Element | null = null;
  rootMargin = '';
  thresholds: ReadonlyArray<number> = [];

  fire(isIntersecting: boolean) {
    this.callback(
      [
        {
          isIntersecting,
          target: this.target as Element,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}

function Probe({ onResult }: { onResult: (visible: boolean) => void }) {
  const { ref, visible } = useLazyMount<HTMLDivElement>({ rootMargin: '200px' });
  useEffect(() => {
    onResult(visible);
  }, [visible, onResult]);
  return <div ref={ref} data-testid="probe" />;
}

beforeEach(() => {
  MockIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useLazyMount', () => {
  it('начинает с visible=false и создаёт IntersectionObserver', () => {
    const cb = vi.fn();
    render(<Probe onResult={cb} />);
    expect(cb).toHaveBeenCalledWith(false);
    expect(MockIntersectionObserver.instances.length).toBe(1);
    expect(MockIntersectionObserver.instances[0].options?.rootMargin).toBe('200px');
  });

  it('переходит в visible=true при isIntersecting=true', () => {
    const cb = vi.fn();
    render(<Probe onResult={cb} />);
    const io = MockIntersectionObserver.instances[0];
    act(() => {
      io.fire(true);
    });
    expect(cb).toHaveBeenLastCalledWith(true);
  });

  it('игнорирует false-события, остаётся в pending', () => {
    const cb = vi.fn();
    render(<Probe onResult={cb} />);
    const io = MockIntersectionObserver.instances[0];
    act(() => {
      io.fire(false);
    });
    expect(cb).toHaveBeenLastCalledWith(false);
  });

  it('после активации disconnect (одноразовый mount)', () => {
    render(<Probe onResult={() => {}} />);
    const io = MockIntersectionObserver.instances[0];
    expect(io.disconnected).toBe(false);
    act(() => {
      io.fire(true);
    });
    expect(io.disconnected).toBe(true);
  });
});

describe('useLazyMount без IntersectionObserver', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('IntersectionObserver', undefined);
  });

  it('fallback=true → visible=true сразу', () => {
    const cb = vi.fn();
    render(<Probe onResult={cb} />);
    expect(cb).toHaveBeenLastCalledWith(true);
  });
});
