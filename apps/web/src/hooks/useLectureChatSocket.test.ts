/**
 * KS-4009 / ADR-121 Phase 1 — тесты хука `useLectureChatSocket`.
 *
 * Покрываем основные кейсы:
 *  - snapshot заполняет messages/pinnedId/mutedSelf;
 *  - chat:message добавляется в ленту;
 *  - chat:delete заменяет текст на `[удалено]`;
 *  - chat:muted ставит mutedSelf=true;
 *  - rate_limited → lastError;
 *  - sendMessage emit'ит с правильным payload и режет пустой/слишком
 *    длинный текст до сервера;
 *  - trim истории до MAX_MESSAGES=500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  LectureChatEvents,
  type LectureChatMessage,
  type LectureChatSnapshotEvent,
} from '@kingside/shared';
import { useLectureChatSocket } from './useLectureChatSocket';

type Handler = (payload: unknown) => void;

function createMockSocket() {
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
  const dispatch = (evt: string, payload: unknown) => {
    (handlers[evt] ?? []).forEach((fn) => fn(payload));
  };
  return { on, off, emit, dispatch } as const;
}

function makeMessage(
  id: string,
  overrides: Partial<LectureChatMessage> = {},
): LectureChatMessage {
  return {
    id,
    lectureId: 'lec-1',
    authorId: 'user-1',
    authorUsername: 'student',
    text: `msg ${id}`,
    createdAt: `2026-06-09T08:00:${String(parseInt(id, 10) % 60).padStart(2, '0')}.000Z`,
    isTrainerMessage: false,
    pinned: false,
    deletedAt: null,
    kind: 'user',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useLectureChatSocket', () => {
  it('snapshot fills state', () => {
    const sock = createMockSocket();
    const { result } = renderHook(() =>
      useLectureChatSocket({
        lectureId: 'lec-1',
         
        socket: sock as any,
      }),
    );

    const snapshot: LectureChatSnapshotEvent = {
      lectureId: 'lec-1',
      messages: [makeMessage('1'), makeMessage('2')],
      pinnedId: '1',
      mutedSelf: false,
    };
    act(() => sock.dispatch(LectureChatEvents.SNAPSHOT, snapshot));

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.pinnedId).toBe('1');
    expect(result.current.mutedSelf).toBe(false);
    expect(result.current.loadingSnapshot).toBe(false);
  });

  it('chat:message appends to feed and dedups by id', () => {
    const sock = createMockSocket();
    const { result } = renderHook(() =>
      useLectureChatSocket({
        lectureId: 'lec-1',
         
        socket: sock as any,
      }),
    );
    act(() => sock.dispatch(LectureChatEvents.MESSAGE, makeMessage('1')));
    act(() => sock.dispatch(LectureChatEvents.MESSAGE, makeMessage('2')));
    // Дубль того же id — игнорируется.
    act(() => sock.dispatch(LectureChatEvents.MESSAGE, makeMessage('1')));
    expect(result.current.messages.map((m) => m.id)).toEqual(['1', '2']);
  });

  it('chat:delete soft-deletes message in place', () => {
    const sock = createMockSocket();
    const { result } = renderHook(() =>
      useLectureChatSocket({
        lectureId: 'lec-1',
         
        socket: sock as any,
      }),
    );
    act(() => sock.dispatch(LectureChatEvents.MESSAGE, makeMessage('m1')));
    act(() =>
      sock.dispatch(LectureChatEvents.DELETED, {
        lectureId: 'lec-1',
        messageId: 'm1',
      }),
    );
    expect(result.current.messages[0].text).toBe('[удалено]');
    expect(result.current.messages[0].deletedAt).not.toBeNull();
  });

  it('chat:muted flips mutedSelf', () => {
    const sock = createMockSocket();
    const { result } = renderHook(() =>
      useLectureChatSocket({
        lectureId: 'lec-1',
         
        socket: sock as any,
      }),
    );
    expect(result.current.mutedSelf).toBe(false);
    act(() =>
      sock.dispatch(LectureChatEvents.MUTED, {
        lectureId: 'lec-1',
        byUserId: 'owner-1',
      }),
    );
    expect(result.current.mutedSelf).toBe(true);
  });

  it('chat:error is exposed via lastError', () => {
    const sock = createMockSocket();
    const { result } = renderHook(() =>
      useLectureChatSocket({
        lectureId: 'lec-1',
         
        socket: sock as any,
      }),
    );
    act(() =>
      sock.dispatch(LectureChatEvents.ERROR, {
        code: 'rate_limited',
        message: 'too fast',
      }),
    );
    expect(result.current.lastError?.code).toBe('rate_limited');
    act(() => result.current.clearError());
    expect(result.current.lastError).toBeNull();
  });

  it('sendMessage emits chat:send with trimmed text', () => {
    const sock = createMockSocket();
    const { result } = renderHook(() =>
      useLectureChatSocket({
        lectureId: 'lec-1',
         
        socket: sock as any,
      }),
    );
    act(() => result.current.sendMessage('   hi   '));
    expect(sock.emit).toHaveBeenCalledWith(LectureChatEvents.SEND, {
      lectureId: 'lec-1',
      text: 'hi',
    });
  });

  it('sendMessage rejects empty text without emit', () => {
    const sock = createMockSocket();
    const { result } = renderHook(() =>
      useLectureChatSocket({
        lectureId: 'lec-1',
         
        socket: sock as any,
      }),
    );
    act(() => result.current.sendMessage('   '));
    expect(sock.emit).not.toHaveBeenCalled();
  });

  it('sendMessage rejects too-long text locally', () => {
    const sock = createMockSocket();
    const { result } = renderHook(() =>
      useLectureChatSocket({
        lectureId: 'lec-1',
         
        socket: sock as any,
      }),
    );
    const longText = 'a'.repeat(501);
    act(() => result.current.sendMessage(longText));
    expect(sock.emit).not.toHaveBeenCalled();
    expect(result.current.lastError?.code).toBe('too_long');
  });

  it('deleteMessage emits chat:delete', () => {
    const sock = createMockSocket();
    const { result } = renderHook(() =>
      useLectureChatSocket({
        lectureId: 'lec-1',
         
        socket: sock as any,
      }),
    );
    act(() => result.current.deleteMessage('msg-7'));
    expect(sock.emit).toHaveBeenCalledWith(LectureChatEvents.DELETE, {
      lectureId: 'lec-1',
      messageId: 'msg-7',
    });
  });

  it('muteUser emits chat:mute', () => {
    const sock = createMockSocket();
    const { result } = renderHook(() =>
      useLectureChatSocket({
        lectureId: 'lec-1',
         
        socket: sock as any,
      }),
    );
    act(() => result.current.muteUser('u-42'));
    expect(sock.emit).toHaveBeenCalledWith(LectureChatEvents.MUTE, {
      lectureId: 'lec-1',
      userId: 'u-42',
    });
  });

  it('history is trimmed to MAX_MESSAGES (500)', () => {
    const sock = createMockSocket();
    const { result } = renderHook(() =>
      useLectureChatSocket({
        lectureId: 'lec-1',
         
        socket: sock as any,
      }),
    );
    act(() => {
      for (let i = 0; i < 520; i++) {
        sock.dispatch(LectureChatEvents.MESSAGE, makeMessage(String(i)));
      }
    });
    expect(result.current.messages).toHaveLength(500);
    // Срез — последние 500: id от 20 до 519.
    expect(result.current.messages[0].id).toBe('20');
    expect(result.current.messages[499].id).toBe('519');
  });

  it('idle when lectureId is null', () => {
    const sock = createMockSocket();
    const { result } = renderHook(() =>
      useLectureChatSocket({
        lectureId: null,
         
        socket: sock as any,
      }),
    );
    expect(sock.on).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
  });
});
