// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { AuthContext } from '../context/AuthContext';
import { useLazySocket } from './useLazySocket';

/**
 * KS-4805 / KS-4818 / ADR-153 §2.1. Refcount-семантика shared-сокетов
 * + реакция на смену `AuthContext.token`.
 *
 * До KS-4805 cleanup безусловно вызывал `disconnect()`. KS-4805 ввёл
 * refcount, но deps хука были `[s, requireAuth]` — токен читался из
 * `localStorage` только при первом mount. Если HintHost mount'ился
 * раньше токена, ref не накладывался; refcount колебался по
 * SPA-страницам. KS-4818 переключает токен на `AuthContext` с
 * `[s, requireAuth, token]` в deps — хук реагирует на появление
 * токена и реально удерживает ref у HintHost.
 */

interface FakeSocket {
  auth: unknown;
  connected: boolean;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeFakeSocket(): FakeSocket {
  const s: FakeSocket = {
    auth: undefined,
    connected: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  s.connect.mockImplementation(() => {
    s.connected = true;
  });
  s.disconnect.mockImplementation(() => {
    s.connected = false;
  });
  return s;
}

function authValue(token: string | null) {
  return {
    user: token ? ({ id: 'u', username: 'u' } as unknown) : null,
    token,
    loading: false,
    login: async () => undefined,
    register: async () => undefined,
    loginWithTokens: () => undefined,
    logout: () => undefined,
    refreshUser: async () => undefined,
  };
}

function makeWrapper(token: string | null) {
  return ({ children }: { children: ReactNode }) => (
    <AuthContext.Provider value={authValue(token) as never}>
      {children}
    </AuthContext.Provider>
  );
}

describe('useLazySocket (KS-4805 refcount + KS-4818 token-reactivity)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('первый mount: connect() вызывается, второй mount на тот же сокет: connect() не повторяется', () => {
    const sock = makeFakeSocket();
    const wrapper = makeWrapper('jwt-test');

    const a = renderHook(() => useLazySocket(sock as unknown as Socket), { wrapper });
    expect(sock.connect).toHaveBeenCalledTimes(1);
    expect(sock.connected).toBe(true);

    const b = renderHook(() => useLazySocket(sock as unknown as Socket), { wrapper });
    expect(sock.connect).toHaveBeenCalledTimes(1);

    a.unmount();
    b.unmount();
  });

  it('два subscriber, один unmount → disconnect() НЕ вызывается; второй unmount → disconnect()', () => {
    const sock = makeFakeSocket();
    const wrapper = makeWrapper('jwt-test');
    const a = renderHook(() => useLazySocket(sock as unknown as Socket), { wrapper });
    const b = renderHook(() => useLazySocket(sock as unknown as Socket), { wrapper });
    expect(sock.disconnect).not.toHaveBeenCalled();

    a.unmount();
    expect(sock.disconnect).not.toHaveBeenCalled();
    expect(sock.connected).toBe(true);

    b.unmount();
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
    expect(sock.connected).toBe(false);
  });

  it('единственный subscriber: mount + unmount → connect+disconnect', () => {
    const sock = makeFakeSocket();
    const a = renderHook(() => useLazySocket(sock as unknown as Socket), {
      wrapper: makeWrapper('jwt-test'),
    });
    expect(sock.connect).toHaveBeenCalledTimes(1);
    a.unmount();
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
  });

  it('mount → unmount → новый mount: connect снова вызывается, refcount корректен', () => {
    const sock = makeFakeSocket();
    const wrapper = makeWrapper('jwt-test');
    const a = renderHook(() => useLazySocket(sock as unknown as Socket), { wrapper });
    a.unmount();
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
    expect(sock.connected).toBe(false);

    const b = renderHook(() => useLazySocket(sock as unknown as Socket), { wrapper });
    expect(sock.connect).toHaveBeenCalledTimes(2);
    expect(sock.connected).toBe(true);

    b.unmount();
    expect(sock.disconnect).toHaveBeenCalledTimes(2);
  });

  it('requireAuth=true (default) и нет токена в AuthContext → ничего не делает, ref не накладывается', () => {
    const sock = makeFakeSocket();
    const a = renderHook(() => useLazySocket(sock as unknown as Socket), {
      wrapper: makeWrapper(null),
    });
    expect(sock.connect).not.toHaveBeenCalled();
    expect(sock.disconnect).not.toHaveBeenCalled();
    a.unmount();
    expect(sock.disconnect).not.toHaveBeenCalled();
  });

  it('requireAuth=false: подключается даже без токена; refcount работает', () => {
    const sock = makeFakeSocket();
    const wrapper = makeWrapper(null);
    const a = renderHook(
      () => useLazySocket(sock as unknown as Socket, false),
      { wrapper },
    );
    const b = renderHook(
      () => useLazySocket(sock as unknown as Socket, false),
      { wrapper },
    );
    expect(sock.connect).toHaveBeenCalledTimes(1);

    a.unmount();
    expect(sock.disconnect).not.toHaveBeenCalled();

    b.unmount();
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
  });

  it('KS-4818: токен появился после mount → хук подключается, ref накладывается', () => {
    const sock = makeFakeSocket();
    let token: string | null = null;
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <AuthContext.Provider value={authValue(token) as never}>
        {children}
      </AuthContext.Provider>
    );

    const h = renderHook(() => useLazySocket(sock as unknown as Socket), {
      wrapper: Wrapper,
    });
    // Изначально без токена — ref не наложен, connect не вызван.
    expect(sock.connect).not.toHaveBeenCalled();

    // Токен пришёл из AuthContext (имитация: state.token обновился).
    token = 'jwt-after-login';
    h.rerender();
    expect(sock.connect).toHaveBeenCalledTimes(1);

    // unmount → disconnect, как и должно быть для единственного держателя.
    h.unmount();
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
  });

  it('KS-4818: HintHost-сценарий — perm-ref не теряется при SPA-навигации между страницами', () => {
    // Имитация: HintHost (всегда mounted), Page A unmount → Page B mount.
    // HintHost накладывает ref на токен. Page A/B тоже накладывают через
    // тот же хук. Ожидание: refcount никогда не падает до 0 пока HintHost
    // в DOM — backend всегда видит >=1 подключение.
    const sock = makeFakeSocket();
    const wrapper = makeWrapper('jwt-test');

    const hintHost = renderHook(() => useLazySocket(sock as unknown as Socket), { wrapper });
    expect(sock.connect).toHaveBeenCalledTimes(1);

    const pageA = renderHook(() => useLazySocket(sock as unknown as Socket), { wrapper });
    expect(sock.connect).toHaveBeenCalledTimes(1); // already connected

    // SPA: Page A → Page B (unmount A, потом mount B).
    pageA.unmount();
    expect(sock.disconnect).not.toHaveBeenCalled();
    expect(sock.connected).toBe(true);

    const pageB = renderHook(() => useLazySocket(sock as unknown as Socket), { wrapper });
    expect(sock.connect).toHaveBeenCalledTimes(1);

    pageB.unmount();
    expect(sock.disconnect).not.toHaveBeenCalled();
    expect(sock.connected).toBe(true);

    // Только когда HintHost unmount'нется (логаут) — disconnect.
    hintHost.unmount();
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
  });
});
