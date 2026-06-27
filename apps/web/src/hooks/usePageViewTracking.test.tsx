// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { usePageViewTracking } from './usePageViewTracking';
import * as eventsModule from '../lib/events';

describe('usePageViewTracking (KS-4684)', () => {
  let trackSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    trackSpy = vi.spyOn(eventsModule, 'track').mockImplementation(() => undefined);
  });

  afterEach(() => {
    trackSpy.mockRestore();
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={['/foo']}>{children}</MemoryRouter>;
  }

  it('шлёт page_view с текущим path и prev_path=null на mount', () => {
    renderHook(() => usePageViewTracking(), { wrapper });
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith('page_view', {
      path: '/foo',
      prev_path: null,
    });
  });

  it('шлёт page_view с prev_path при навигации', () => {
    function Harness() {
      usePageViewTracking();
      const navigate = useNavigate();
      return (
        <button data-testid="go" onClick={() => navigate('/bar')}>
          go
        </button>
      );
    }

    const { getByTestId } = render(
      <MemoryRouter initialEntries={['/foo']}>
        <Routes>
          <Route path="*" element={<Harness />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(trackSpy).toHaveBeenLastCalledWith('page_view', {
      path: '/foo',
      prev_path: null,
    });

    act(() => {
      getByTestId('go').click();
    });

    expect(trackSpy).toHaveBeenLastCalledWith('page_view', {
      path: '/bar',
      prev_path: '/foo',
    });
  });

  it('не дублирует событие при одинаковом path', () => {
    const { rerender } = renderHook(() => usePageViewTracking(), { wrapper });
    rerender();
    rerender();
    expect(trackSpy).toHaveBeenCalledTimes(1);
  });
});
