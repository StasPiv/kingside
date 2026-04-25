import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import { LazySection } from './LazySection';

/**
 * KS-1924: обёртка для секций «ниже сгиба» — до пересечения с
 * viewport показывает fallback, после — children.
 */

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  target: Element | null = null;

  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb;
    MockIntersectionObserver.instances.push(this);
  }
  observe(target: Element) {
    this.target = target;
  }
  unobserve() {}
  disconnect() {}
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

beforeEach(() => {
  MockIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<LazySection>', () => {
  it('пока pending → рендерит fallback, не children', () => {
    render(
      <LazySection
        testId="lazy"
        fallback={<div data-testid="placeholder" />}
      >
        <div data-testid="real" />
      </LazySection>,
    );
    expect(screen.getByTestId('placeholder')).toBeInTheDocument();
    expect(screen.queryByTestId('real')).not.toBeInTheDocument();
    expect(screen.getByTestId('lazy').getAttribute('data-lazy-state')).toBe(
      'pending',
    );
  });

  it('после пересечения → рендерит children, не fallback', () => {
    render(
      <LazySection
        testId="lazy"
        fallback={<div data-testid="placeholder" />}
      >
        <div data-testid="real" />
      </LazySection>,
    );
    const io = MockIntersectionObserver.instances[0];
    act(() => {
      io.fire(true);
    });
    expect(screen.queryByTestId('placeholder')).not.toBeInTheDocument();
    expect(screen.getByTestId('real')).toBeInTheDocument();
    expect(screen.getByTestId('lazy').getAttribute('data-lazy-state')).toBe(
      'mounted',
    );
  });
});
