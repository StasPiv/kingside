import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { WsMatchmakingNoOpponentsPayload } from '@kingside/shared';

/**
 * KS-2185 — поведение хука matchmaking при событии MATCHMAKING_NO_OPPONENTS.
 *
 * Проверяем:
 *  - Сценарий 1: при получении события `matchmaking:no_opponents` хук
 *    переводит UI в состояние `noOpponents != null`, сбрасывает `searching`,
 *    и НЕ инициирует переход на партию (`navigate` не вызывается). Этот
 *    последний пункт — ключевой: подтверждает, что локальный
 *    Stockfish-WASM/bot-флоу не активируется.
 *  - `retryAfterNoOpponents` повторно отправляет тот же JOIN-payload и
 *    включает `searching` снова.
 *  - `dismissNoOpponents` чистит блок без повторного JOIN.
 *  - На FOUND — `navigate('/game/:id')` вызывается (regression: обычный
 *    matchmaking-флоу остался рабочим).
 */

type Listener = (...args: unknown[]) => void;

const { socketMock, navigateMock, authMock } = vi.hoisted(() => {
  const listeners = new Map<string, Set<Listener>>();
  const socket = {
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
  };
  return {
    socketMock: socket,
    navigateMock: vi.fn(),
    authMock: { user: null as { id: string; username: string } | null },
  };
});

vi.mock('../socket', () => ({
  matchmakingSocket: socketMock,
}));

vi.mock('./useLazySocket', () => ({
  useLazySocket: vi.fn(),
}));

vi.mock('./useServerBusy', () => ({
  useServerBusy: () => false,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: authMock.user,
    loading: false,
  }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

import { useMatchmaking } from './useMatchmaking';

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

beforeEach(() => {
  socketMock.listeners.clear();
  socketMock.on.mockClear();
  socketMock.off.mockClear();
  socketMock.emit.mockClear();
  navigateMock.mockClear();
  authMock.user = null;
});

describe('useMatchmaking — KS-2185 NO_OPPONENTS handling', () => {
  it('сценарий 1: событие MATCHMAKING_NO_OPPONENTS → блок виден, navigate не вызывается, searching=false', () => {
    const { result } = renderHook(() => useMatchmaking(), { wrapper });

    act(() => {
      result.current.handleSearch({ timeInitial: 60, increment: 0, activeTab: 'bullet' });
    });
    expect(socketMock.emit).toHaveBeenCalledWith('matchmaking:join', { timeInitial: 60, increment: 0 });
    expect(result.current.searching).toBe(true);
    expect(result.current.noOpponents).toBeNull();

    const payload: WsMatchmakingNoOpponentsPayload = {
      category: 'bullet',
      tc: { timeInitial: 60, increment: 0 },
      waitedMs: 60000,
    };
    act(() => {
      socketMock.__dispatch('matchmaking:no_opponents', payload);
    });

    expect(result.current.searching).toBe(false);
    expect(result.current.noOpponents).toEqual(payload);
    // Локальный Stockfish-WASM/bot-флоу НЕ запускается — переход в партию не происходит.
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('retryAfterNoOpponents: повторно шлёт тот же JOIN payload и включает searching', () => {
    const { result } = renderHook(() => useMatchmaking(), { wrapper });

    act(() => {
      result.current.handleSearch({ timeInitial: 180, increment: 2, activeTab: 'blitz' });
    });
    act(() => {
      socketMock.__dispatch('matchmaking:no_opponents', {
        category: 'blitz',
        tc: { timeInitial: 180, increment: 2 },
        waitedMs: 60000,
      });
    });
    socketMock.emit.mockClear();

    act(() => {
      result.current.retryAfterNoOpponents();
    });

    expect(socketMock.emit).toHaveBeenCalledWith('matchmaking:join', { timeInitial: 180, increment: 2 });
    expect(result.current.searching).toBe(true);
    expect(result.current.noOpponents).toBeNull();
  });

  it('dismissNoOpponents: только сбрасывает блок, JOIN не отправляется', () => {
    const { result } = renderHook(() => useMatchmaking(), { wrapper });

    act(() => {
      result.current.handleSearch({ timeInitial: 60, increment: 0, activeTab: 'bullet' });
    });
    act(() => {
      socketMock.__dispatch('matchmaking:no_opponents', {
        category: 'bullet',
        tc: { timeInitial: 60, increment: 0 },
        waitedMs: 60000,
      });
    });
    socketMock.emit.mockClear();

    act(() => {
      result.current.dismissNoOpponents();
    });

    expect(result.current.noOpponents).toBeNull();
    expect(socketMock.emit).not.toHaveBeenCalled();
  });

  it('regression: на событии FOUND переход в /game/:id (классический флоу не сломан)', () => {
    const { result } = renderHook(() => useMatchmaking(), { wrapper });

    act(() => {
      result.current.handleSearch({ timeInitial: 60, increment: 0, activeTab: 'bullet' });
    });

    act(() => {
      socketMock.__dispatch('matchmaking:found', { gameId: 'g-1', color: 'white' });
    });

    expect(navigateMock).toHaveBeenCalledWith('/game/g-1', { state: { color: 'white' } });
    expect(result.current.searching).toBe(false);
    expect(result.current.noOpponents).toBeNull();
  });
});
