// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { useLazySocket } from './useLazySocket';

/**
 * KS-4805 / ADR-153 §2.1. Refcount-семантика shared-сокетов.
 *
 * До правки `useLazySocket` cleanup безусловно вызывал `disconnect()` —
 * room `user:<id>` пустела на десятки/сотни миллисекунд при SPA-навигации,
 * backend-self-emit'ы (hint:show, KS-4784) уходили в пустоту.
 *
 * Эти тесты фиксируют контракт: счётчик растёт на каждый mount, падает
 * на unmount, и `disconnect()` срабатывает только при count → 0.
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

describe('useLazySocket (KS-4805 refcount)', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('token', 'jwt-test');
  });

  it('первый mount: connect() вызывается, второй mount на тот же сокет: connect() не повторяется', () => {
    const sock = makeFakeSocket();

    const a = renderHook(() => useLazySocket(sock as unknown as Socket));
    expect(sock.connect).toHaveBeenCalledTimes(1);
    expect(sock.connected).toBe(true);

    const b = renderHook(() => useLazySocket(sock as unknown as Socket));
    // socket уже connected — повторный connect() не нужен.
    expect(sock.connect).toHaveBeenCalledTimes(1);

    a.unmount();
    b.unmount();
  });

  it('два subscriber, один unmount → disconnect() НЕ вызывается; второй unmount → disconnect()', () => {
    const sock = makeFakeSocket();
    const a = renderHook(() => useLazySocket(sock as unknown as Socket));
    const b = renderHook(() => useLazySocket(sock as unknown as Socket));
    expect(sock.disconnect).not.toHaveBeenCalled();

    a.unmount();
    // HintHost ещё держит ref — room user:<id> должна оставаться живой.
    expect(sock.disconnect).not.toHaveBeenCalled();
    expect(sock.connected).toBe(true);

    b.unmount();
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
    expect(sock.connected).toBe(false);
  });

  it('единственный subscriber: mount + unmount → connect+disconnect', () => {
    const sock = makeFakeSocket();
    const a = renderHook(() => useLazySocket(sock as unknown as Socket));
    expect(sock.connect).toHaveBeenCalledTimes(1);
    a.unmount();
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
  });

  it('mount → unmount → новый mount: connect снова вызывается, refcount корректен', () => {
    const sock = makeFakeSocket();
    const a = renderHook(() => useLazySocket(sock as unknown as Socket));
    a.unmount();
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
    expect(sock.connected).toBe(false);

    const b = renderHook(() => useLazySocket(sock as unknown as Socket));
    expect(sock.connect).toHaveBeenCalledTimes(2);
    expect(sock.connected).toBe(true);

    b.unmount();
    expect(sock.disconnect).toHaveBeenCalledTimes(2);
  });

  it('requireAuth=true (default) и нет токена в localStorage → ничего не делает, ref не накладывается', () => {
    localStorage.clear();
    const sock = makeFakeSocket();

    const a = renderHook(() => useLazySocket(sock as unknown as Socket));
    expect(sock.connect).not.toHaveBeenCalled();
    expect(sock.disconnect).not.toHaveBeenCalled();

    a.unmount();
    expect(sock.disconnect).not.toHaveBeenCalled();
  });

  it('requireAuth=false: подключается даже без токена; refcount работает', () => {
    localStorage.clear();
    const sock = makeFakeSocket();
    const a = renderHook(() =>
      useLazySocket(sock as unknown as Socket, false),
    );
    const b = renderHook(() =>
      useLazySocket(sock as unknown as Socket, false),
    );
    expect(sock.connect).toHaveBeenCalledTimes(1);

    a.unmount();
    expect(sock.disconnect).not.toHaveBeenCalled();

    b.unmount();
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
  });

  it('гость (без токена) + перм-владелец (есть токен): когда токен появляется, refcount корректно растёт', () => {
    // Этот сценарий моделирует: первый mount был guest (token нет, ref
    // не наложен), второй mount после login (token есть, ref +1).
    // Unmount первого — refcount не трогает; unmount второго → disconnect.
    localStorage.clear();
    const sock = makeFakeSocket();

    const guest = renderHook(() => useLazySocket(sock as unknown as Socket));
    expect(sock.connect).not.toHaveBeenCalled();

    localStorage.setItem('token', 'jwt-after-login');
    const user = renderHook(() => useLazySocket(sock as unknown as Socket));
    expect(sock.connect).toHaveBeenCalledTimes(1);

    guest.unmount();
    expect(sock.disconnect).not.toHaveBeenCalled();

    user.unmount();
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
  });
});
