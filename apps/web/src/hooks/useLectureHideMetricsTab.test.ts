/**
 * KS-4042. Тесты `useLectureHideMetricsTab(slug, initial)`.
 *
 * Покрытие зеркалит `useLectureToolsPolicy.test.ts`:
 *  - initial берётся из REST snapshot (true / false / undefined);
 *  - смена initial между рендерами синхронизирует state;
 *  - WS-событие `LECTURE_TOOLS` со совпадающим slug обновляет state на
 *    новое `hideMetricsTab` (KS-4041 расширил payload);
 *  - событие с чужим slug игнорируется;
 *  - cleanup при unmount снимает listener;
 *  - смена slug — старый listener снят, новый подписан.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  LiveAnalysisEvents,
  type LectureToolsChangedEvent,
} from '@kingside/shared';

type Listener = (...args: unknown[]) => void;

const { socketMock } = vi.hoisted(() => {
  const listeners = new Map<string, Set<Listener>>();
  return {
    socketMock: {
      listeners,
      on: vi.fn((event: string, fn: Listener) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      }),
      off: vi.fn((event: string, fn: Listener) => {
        listeners.get(event)?.delete(fn);
      }),
      emit: vi.fn(),
      connected: true,
      connect: vi.fn(),
      disconnect: vi.fn(),
      __dispatch(event: string, payload?: unknown) {
        listeners.get(event)?.forEach((fn) => fn(payload));
      },
    },
  };
});

vi.mock('../socket', () => ({
  liveAnalysisSocket: socketMock,
}));

import { useLectureHideMetricsTab } from './useLectureHideMetricsTab';

function evt(
  slug: string,
  hideMetricsTab: boolean,
): LectureToolsChangedEvent {
  return {
    slug,
    lectureId: `lec-${slug}`,
    disabledTools: [],
    hideMetricsTab,
  };
}

beforeEach(() => {
  socketMock.listeners.clear();
  socketMock.on.mockClear();
  socketMock.off.mockClear();
});

describe('useLectureHideMetricsTab', () => {
  it('initial=true → возвращает true', () => {
    const { result } = renderHook(() =>
      useLectureHideMetricsTab('slug-1', true),
    );
    expect(result.current).toBe(true);
  });

  it('initial undefined → false (fallback)', () => {
    const { result } = renderHook(() =>
      useLectureHideMetricsTab('slug-1'),
    );
    expect(result.current).toBe(false);
  });

  it('initial null → false', () => {
    const { result } = renderHook(() =>
      useLectureHideMetricsTab('slug-1', null),
    );
    expect(result.current).toBe(false);
  });

  it('смена initial между рендерами → state синхронизируется', () => {
    const { result, rerender } = renderHook(
      ({ initial }: { initial?: boolean }) =>
        useLectureHideMetricsTab('slug-1', initial),
      { initialProps: { initial: false } },
    );
    expect(result.current).toBe(false);
    rerender({ initial: true });
    expect(result.current).toBe(true);
  });

  it('WS-событие LECTURE_TOOLS с совпадающим slug обновляет state', () => {
    const { result } = renderHook(() =>
      useLectureHideMetricsTab('slug-1', false),
    );
    expect(result.current).toBe(false);
    act(() => {
      socketMock.__dispatch(
        LiveAnalysisEvents.LECTURE_TOOLS,
        evt('slug-1', true),
      );
    });
    expect(result.current).toBe(true);
  });

  it('WS-событие с другим slug — игнорируется', () => {
    const { result } = renderHook(() =>
      useLectureHideMetricsTab('slug-1', false),
    );
    act(() => {
      socketMock.__dispatch(
        LiveAnalysisEvents.LECTURE_TOOLS,
        evt('slug-2', true),
      );
    });
    expect(result.current).toBe(false);
  });

  it('подписка через socket.on + отписка в cleanup при unmount', () => {
    const { unmount } = renderHook(() =>
      useLectureHideMetricsTab('slug-1'),
    );
    expect(socketMock.on).toHaveBeenCalledWith(
      LiveAnalysisEvents.LECTURE_TOOLS,
      expect.any(Function),
    );
    expect(
      socketMock.listeners.get(LiveAnalysisEvents.LECTURE_TOOLS)?.size,
    ).toBe(1);
    unmount();
    expect(socketMock.off).toHaveBeenCalled();
    expect(
      socketMock.listeners.get(LiveAnalysisEvents.LECTURE_TOOLS)?.size ?? 0,
    ).toBe(0);
  });

  it('смена slug — старый listener снят, событие со старым slug игнорируется', () => {
    const { result, rerender } = renderHook(
      ({ slug }: { slug: string }) =>
        useLectureHideMetricsTab(slug, false),
      { initialProps: { slug: 'slug-1' } },
    );
    rerender({ slug: 'slug-2' });
    expect(
      socketMock.listeners.get(LiveAnalysisEvents.LECTURE_TOOLS)?.size,
    ).toBe(1);

    act(() => {
      socketMock.__dispatch(
        LiveAnalysisEvents.LECTURE_TOOLS,
        evt('slug-1', true),
      );
    });
    expect(result.current).toBe(false);

    act(() => {
      socketMock.__dispatch(
        LiveAnalysisEvents.LECTURE_TOOLS,
        evt('slug-2', true),
      );
    });
    expect(result.current).toBe(true);
  });

  it('slug=null — подписка не создаётся, state остаётся равной initial', () => {
    const { result } = renderHook(() =>
      useLectureHideMetricsTab(null, true),
    );
    expect(result.current).toBe(true);
    expect(
      socketMock.listeners.get(LiveAnalysisEvents.LECTURE_TOOLS)?.size ?? 0,
    ).toBe(0);
  });
});
