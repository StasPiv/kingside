import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import {
  LectureChatEvents,
  LECTURE_CHAT_LIMITS,
  type LectureChatDeleteEvent,
  type LectureChatErrorEvent,
  type LectureChatMessage,
  type LectureChatMutedEvent,
  type LectureChatSnapshotEvent,
} from '@kingside/shared';

/**
 * KS-4009 / ADR-121 Phase 1 §6, §7. Хук-обвязка над общим
 * `liveAnalysisSocket` для чата лекции.
 *
 * Поведение:
 *   1. Подписка на серверные события `chat:snapshot`, `chat:message`,
 *      `chat:delete`, `chat:muted`, `chat:error`.
 *   2. Отправка `chat:send`, `chat:delete`, `chat:mute`.
 *   3. Локальный стейт: `messages` (хронологически), `pinnedId`,
 *      `mutedSelf`, `lastError`.
 *   4. Подрезка истории в памяти до `MAX_MESSAGES = 500`
 *      (ADR-121 §2.3): чат лекции — fire-and-forget лента,
 *      сохранять всё нет смысла, при scroll'е выше у пользователя
 *      «уезжают» самые старые сообщения.
 *   5. Хук «спит» если не передан `lectureId` или `socket` — это
 *      нормальный idle-кейс для страниц анализа без активной лекции.
 *
 * Хук НЕ управляет подключением сокета — это делает
 * `useLiveAnalysisSocket` через `live-analysis:subscribe { slug }`,
 * после которого сервер сам шлёт `chat:snapshot`. Здесь мы только
 * подписываемся на входящие события и шлём исходящие.
 */

/**
 * ADR-121 §2.3: верхний предел сообщений в памяти UI. Считаем что
 * один сеанс лекции редко переваливает за 500 сообщений; при
 * превышении самые ранние выпадают (chat — не source of truth).
 */
const MAX_MESSAGES = 500;

export interface UseLectureChatSocketArgs {
  /** ID лекции. `null` — хук спит. */
  lectureId: string | null | undefined;
  /**
   * Подключённый сокет к namespace `/live-analysis`. Обычно
   * глобальный `liveAnalysisSocket` из `apps/web/src/socket.ts`.
   */
  socket: Socket | null | undefined;
}

export interface UseLectureChatSocketState {
  /** Сообщения в хронологическом порядке (старые → новые). */
  messages: LectureChatMessage[];
  /** ID закреплённого сообщения (Phase 2) или null. */
  pinnedId: string | null;
  /** Выключен ли текущий пользователь в этой лекции. */
  mutedSelf: boolean;
  /** Последняя ошибка от сервера (`chat:error`). */
  lastError: LectureChatErrorEvent | null;
  /** true пока snapshot не пришёл (или лекция не активна). */
  loadingSnapshot: boolean;
  /** Отправка нового сообщения. */
  sendMessage: (text: string) => void;
  /** Удаление сообщения (только владелец лекции). */
  deleteMessage: (messageId: string) => void;
  /** Выключить участника в текущей лекции (только владелец). */
  muteUser: (userId: string) => void;
  /** Сбросить последнюю ошибку (после показа в UI). */
  clearError: () => void;
}

export function useLectureChatSocket({
  lectureId,
  socket,
}: UseLectureChatSocketArgs): UseLectureChatSocketState {
  const [messages, setMessages] = useState<LectureChatMessage[]>([]);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [mutedSelf, setMutedSelf] = useState(false);
  const [lastError, setLastError] = useState<LectureChatErrorEvent | null>(
    null,
  );
  const [loadingSnapshot, setLoadingSnapshot] = useState(true);

  // ref для актуального lectureId внутри замыканий-обработчиков.
  const lectureIdRef = useRef(lectureId);
  useEffect(() => {
    lectureIdRef.current = lectureId;
  }, [lectureId]);

  useEffect(() => {
    if (!lectureId || !socket) {
      setMessages([]);
      setPinnedId(null);
      setMutedSelf(false);
      setLastError(null);
      setLoadingSnapshot(true);
      return;
    }

    const handleSnapshot = (payload: LectureChatSnapshotEvent) => {
      if (payload?.lectureId !== lectureIdRef.current) return;
      // snapshot приходит хронологически от сервера; на всякий случай
      // ещё раз сортируем по createdAt — на случай serialization drift.
      const sorted = [...payload.messages].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      // ADR-121 §6 SNAPSHOT_LIMIT=100, MAX_MESSAGES в UI=500.
      // Срезаем до MAX_MESSAGES — на случай, если сервер отдаст больше.
      const trimmed =
        sorted.length > MAX_MESSAGES ? sorted.slice(-MAX_MESSAGES) : sorted;
      setMessages(trimmed);
      setPinnedId(payload.pinnedId ?? null);
      setMutedSelf(Boolean(payload.mutedSelf));
      setLoadingSnapshot(false);
    };

    const handleMessage = (payload: LectureChatMessage) => {
      if (payload?.lectureId !== lectureIdRef.current) return;
      setMessages((prev) => {
        // Идемпотентность: при ре-broadcast того же сообщения
        // (например, ack-by-room для собственного chat:send) не
        // дублируем.
        if (prev.some((m) => m.id === payload.id)) return prev;
        const next = [...prev, payload];
        return next.length > MAX_MESSAGES
          ? next.slice(next.length - MAX_MESSAGES)
          : next;
      });
    };

    const handleDelete = (payload: LectureChatDeleteEvent) => {
      if (payload?.lectureId !== lectureIdRef.current) return;
      const nowIso = new Date().toISOString();
      setMessages((prev) =>
        prev.map((m) =>
          m.id === payload.messageId
            // KS-4633: sentinel `[deleted]` — фронт подменяет на
            // локализованную строку через `t('lectureChat.deletedPlaceholder')`.
            ? { ...m, text: '[deleted]', deletedAt: nowIso }
            : m,
        ),
      );
    };

    const handleMuted = (payload: LectureChatMutedEvent) => {
      if (payload?.lectureId !== lectureIdRef.current) return;
      setMutedSelf(true);
    };

    const handleError = (payload: LectureChatErrorEvent) => {
      setLastError(payload ?? null);
    };

    socket.on(LectureChatEvents.SNAPSHOT, handleSnapshot);
    socket.on(LectureChatEvents.MESSAGE, handleMessage);
    socket.on(LectureChatEvents.DELETED, handleDelete);
    socket.on(LectureChatEvents.MUTED, handleMuted);
    socket.on(LectureChatEvents.ERROR, handleError);

    return () => {
      socket.off(LectureChatEvents.SNAPSHOT, handleSnapshot);
      socket.off(LectureChatEvents.MESSAGE, handleMessage);
      socket.off(LectureChatEvents.DELETED, handleDelete);
      socket.off(LectureChatEvents.MUTED, handleMuted);
      socket.off(LectureChatEvents.ERROR, handleError);
    };
  }, [lectureId, socket]);

  const sendMessage = useCallback(
    (text: string) => {
      const lid = lectureIdRef.current;
      if (!lid || !socket) return;
      const trimmed = text.replace(/\s+$/u, '').replace(/^\s+/u, '');
      if (!trimmed) return;
      // Локальная проверка длины (codepoints) — сервер всё равно
      // подтвердит, но UX лучше когда ошибка не уходит в сеть.
      const codepoints = Array.from(trimmed);
      if (codepoints.length > LECTURE_CHAT_LIMITS.MAX_TEXT_LENGTH) {
        // KS-4633: `message` — fallback для UI, англ. Локализация
        // делается в `LectureChatPanel` через `t('lectureChat.errors.too_long')`.
        setLastError({
          code: 'too_long',
          message: 'Message is too long',
        });
        return;
      }
      socket.emit(LectureChatEvents.SEND, { lectureId: lid, text: trimmed });
    },
    [socket],
  );

  const deleteMessage = useCallback(
    (messageId: string) => {
      const lid = lectureIdRef.current;
      if (!lid || !socket || !messageId) return;
      socket.emit(LectureChatEvents.DELETE, { lectureId: lid, messageId });
    },
    [socket],
  );

  const muteUser = useCallback(
    (userId: string) => {
      const lid = lectureIdRef.current;
      if (!lid || !socket || !userId) return;
      socket.emit(LectureChatEvents.MUTE, { lectureId: lid, userId });
    },
    [socket],
  );

  const clearError = useCallback(() => setLastError(null), []);

  return useMemo(
    () => ({
      messages,
      pinnedId,
      mutedSelf,
      lastError,
      loadingSnapshot,
      sendMessage,
      deleteMessage,
      muteUser,
      clearError,
    }),
    [
      messages,
      pinnedId,
      mutedSelf,
      lastError,
      loadingSnapshot,
      sendMessage,
      deleteMessage,
      muteUser,
      clearError,
    ],
  );
}
