/**
 * KS-3905 / ADR-117 C01. Тесты `useLectureToolsPolicy(slug, initial)`.
 *
 * Покрытие:
 *  - начальное значение берётся из `initial` (пришедшего извне
 *    `LiveAnalysisResponse` / sync-snapshot);
 *  - смена `initial` на rerender'е синхронизирует state (например,
 *    дождались REST-ответа после первого монта);
 *  - WS-событие `live-analysis:lecture-tools` (`LECTURE_TOOLS`) с
 *    совпадающим `slug` обновляет state;
 *  - событие с чужим `slug` игнорируется (cross-room защита);
 *  - cleanup при unmount снимает listener;
 *  - смена `slug` снимает старый listener и подписывает новый.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  LiveAnalysisEvents,
  type LectureDisabledTool,
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

import { useLectureToolsPolicy } from './useLectureToolsPolicy';

beforeEach(() => {
  socketMock.listeners.clear();
  socketMock.on.mockClear();
  socketMock.off.mockClear();
});

describe('useLectureToolsPolicy', () => {
  it('начальное значение берётся из переданного initial', () => {
    const initial: LectureDisabledTool[] = ['engine', 'book'];
    const { result } = renderHook(() =>
      useLectureToolsPolicy('slug-1', initial),
    );
    expect(result.current).toEqual(['engine', 'book']);
  });

  it('initial undefined → policy = []', () => {
    const { result } = renderHook(() => useLectureToolsPolicy('slug-1'));
    expect(result.current).toEqual([]);
  });

  it('initial null → policy = []', () => {
    const { result } = renderHook(() =>
      useLectureToolsPolicy('slug-1', null),
    );
    expect(result.current).toEqual([]);
  });

  it('смена initial между рендерами → policy синхронизируется', () => {
    const first: LectureDisabledTool[] = ['engine'];
    const second: LectureDisabledTool[] = ['engine', 'ai_comment'];
    const { result, rerender } = renderHook(
      ({ initial }: { initial?: LectureDisabledTool[] }) =>
        useLectureToolsPolicy('slug-1', initial),
      { initialProps: { initial: first } },
    );
    expect(result.current).toEqual(['engine']);
    rerender({ initial: second });
    expect(result.current).toEqual(['engine', 'ai_comment']);
  });

  it('WS-событие LECTURE_TOOLS с совпадающим slug обновляет policy', () => {
    const { result } = renderHook(() => useLectureToolsPolicy('slug-1'));
    expect(result.current).toEqual([]);
    const payload: LectureToolsChangedEvent = {
      slug: 'slug-1',
      lectureId: 'lec-1',
      disabledTools: ['engine', 'ai_comment', 'generate_puzzle'],
    };
    act(() => {
      socketMock.__dispatch(LiveAnalysisEvents.LECTURE_TOOLS, payload);
    });
    expect(result.current).toEqual([
      'engine',
      'ai_comment',
      'generate_puzzle',
    ]);
  });

  it('WS-событие с другим slug — игнорируется (cross-room защита)', () => {
    const { result } = renderHook(() =>
      useLectureToolsPolicy('slug-1', ['engine']),
    );
    const payload: LectureToolsChangedEvent = {
      slug: 'slug-2',
      lectureId: 'lec-2',
      disabledTools: ['book'],
    };
    act(() => {
      socketMock.__dispatch(LiveAnalysisEvents.LECTURE_TOOLS, payload);
    });
    expect(result.current).toEqual(['engine']);
  });

  it('подписка через socket.on + отписка в cleanup при unmount', () => {
    const { unmount } = renderHook(() => useLectureToolsPolicy('slug-1'));
    expect(socketMock.on).toHaveBeenCalledWith(
      LiveAnalysisEvents.LECTURE_TOOLS,
      expect.any(Function),
    );
    expect(
      socketMock.listeners.get(LiveAnalysisEvents.LECTURE_TOOLS)?.size,
    ).toBe(1);

    unmount();
    expect(socketMock.off).toHaveBeenCalledWith(
      LiveAnalysisEvents.LECTURE_TOOLS,
      expect.any(Function),
    );
    expect(
      socketMock.listeners.get(LiveAnalysisEvents.LECTURE_TOOLS)?.size ?? 0,
    ).toBe(0);
  });

  it('смена slug — старый listener снят, новый подписан, событие со старым slug игнорируется', () => {
    const { result, rerender } = renderHook(
      ({ slug }: { slug: string }) => useLectureToolsPolicy(slug),
      { initialProps: { slug: 'slug-1' } },
    );
    expect(
      socketMock.listeners.get(LiveAnalysisEvents.LECTURE_TOOLS)?.size,
    ).toBe(1);

    rerender({ slug: 'slug-2' });
    // Slug-эффект пересоздаётся: старый off + новый on. Подписчик
    // остаётся ровно один.
    expect(
      socketMock.listeners.get(LiveAnalysisEvents.LECTURE_TOOLS)?.size,
    ).toBe(1);

    // Событие со старым slug — игнорируется новым listener'ом по
    // фильтру `payload.slug !== slug`.
    act(() => {
      socketMock.__dispatch(LiveAnalysisEvents.LECTURE_TOOLS, {
        slug: 'slug-1',
        lectureId: 'lec-1',
        disabledTools: ['engine'],
      } as LectureToolsChangedEvent);
    });
    expect(result.current).toEqual([]);

    // Событие с новым slug — применяется.
    act(() => {
      socketMock.__dispatch(LiveAnalysisEvents.LECTURE_TOOLS, {
        slug: 'slug-2',
        lectureId: 'lec-2',
        disabledTools: ['book'],
      } as LectureToolsChangedEvent);
    });
    expect(result.current).toEqual(['book']);
  });

  it('slug=null — подписка не создаётся; policy остаётся равной initial', () => {
    const { result } = renderHook(() =>
      useLectureToolsPolicy(null, ['engine']),
    );
    expect(result.current).toEqual(['engine']);
    expect(
      socketMock.listeners.get(LiveAnalysisEvents.LECTURE_TOOLS)?.size ?? 0,
    ).toBe(0);
  });
});
