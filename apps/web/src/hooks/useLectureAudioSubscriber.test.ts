/**
 * KS-4014 / ADR-116 §5.2. Regression-тест: `useLectureAudioSubscriber`
 * должен после mount-а отправить `webrtc:peer-joined { lectureId }`
 * (саморегистрация в peer-list лекции, без неё gateway не пришлёт
 * publisher-у запрос на offer). Без этого emit-а зритель никогда не
 * получит звука — именно об этом сообщал devops в KS-4012.
 *
 * Дополнительно проверяем:
 *  - повторный peer-joined при rejoin-таймере, пока pc не создан;
 *  - cleanup отправляет `webrtc:peer-left` и снимает listener'ы;
 *  - при `lectureId=null` или `socket=null` хук «спит» и ничего
 *    не emit-ит.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLectureAudioSubscriber } from './useLectureAudioSubscriber';

type Handler = (payload: unknown) => void;

function createMockSocket(opts: { connected?: boolean; id?: string } = {}) {
  const handlers: Record<string, Handler[]> = {};
  const emit = vi.fn();
  const on = vi.fn((evt: string, fn: Handler) => {
    handlers[evt] = handlers[evt] ?? [];
    handlers[evt].push(fn);
  });
  const off = vi.fn((evt: string, fn: Handler) => {
    if (!handlers[evt]) return;
    handlers[evt] = handlers[evt].filter((h) => h !== fn);
  });
  const connect = vi.fn();
  return {
    on,
    off,
    emit,
    connect,
    connected: opts.connected ?? true,
    id: opts.id ?? 'viewer-sock-1',
  } as const;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLectureAudioSubscriber', () => {
  it('emits webrtc:peer-joined on mount with current lectureId', () => {
    const sock = createMockSocket({ connected: true, id: 'sock-A' });
    renderHook(() =>
      useLectureAudioSubscriber({
        lectureId: 'lec-1',
         
        socket: sock as any,
      }),
    );
    expect(sock.emit).toHaveBeenCalledWith('webrtc:peer-joined', {
      lectureId: 'lec-1',
    });
  });

  it('rejoin: повторяет peer-joined каждые 3 секунды пока pc не создан', () => {
    const sock = createMockSocket({ connected: true });
    renderHook(() =>
      useLectureAudioSubscriber({
        lectureId: 'lec-1',
         
        socket: sock as any,
      }),
    );
    // initial emit
    expect(sock.emit).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(sock.emit).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(sock.emit).toHaveBeenCalledTimes(3);
  });

  it('cleanup: на unmount отправляется webrtc:peer-left и снимаются listener-ы', () => {
    const sock = createMockSocket({ connected: true });
    const { unmount } = renderHook(() =>
      useLectureAudioSubscriber({
        lectureId: 'lec-1',
         
        socket: sock as any,
      }),
    );
    sock.emit.mockClear();
    unmount();
    // первый emit после unmount — peer-left
    expect(sock.emit).toHaveBeenCalledWith('webrtc:peer-left', {
      lectureId: 'lec-1',
    });
    // listener-ы сняты по основным каналам
    const offEvents = sock.off.mock.calls.map((c) => c[0]);
    expect(offEvents).toContain('webrtc:offer');
    expect(offEvents).toContain('webrtc:ice');
    expect(offEvents).toContain('webrtc:peer-left');
    expect(offEvents).toContain('webrtc:capacity-exceeded');
  });

  it('idle: lectureId=null — peer-joined не emit-ится', () => {
    const sock = createMockSocket({ connected: true });
    renderHook(() =>
      useLectureAudioSubscriber({
        lectureId: null,
         
        socket: sock as any,
      }),
    );
    expect(sock.emit).not.toHaveBeenCalled();
  });

  it('idle: socket=null — peer-joined не emit-ится', () => {
    renderHook(() =>
      useLectureAudioSubscriber({
        lectureId: 'lec-1',
        socket: null,
      }),
    );
    // Просто не падает; emit вызывать некому.
    expect(true).toBe(true);
  });

  it('socket.connect() вызывается если сокет не подключён', () => {
    const sock = createMockSocket({ connected: false });
    renderHook(() =>
      useLectureAudioSubscriber({
        lectureId: 'lec-1',
         
        socket: sock as any,
      }),
    );
    expect(sock.connect).toHaveBeenCalled();
  });
});
