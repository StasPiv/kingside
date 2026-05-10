import { useEffect, useRef, useState } from 'react';
import type { BroadcastGameSummary } from '@kingside/shared';
import { broadcastSocket } from '../socket';

/**
 * KS-2701. Подписка на socket.io канал broadcast-сервиса для конкретного
 * раунда. Backend (KS-2699 + gateway) публикует:
 *  - `broadcast:sync` — полный snapshot `{roundId, games[]}` со всеми
 *    играми раунда (initial при `broadcast:subscribe` + при каждом
 *    обновлении). В payload уже есть `whiteClockMs/blackClockMs/
 *    clockUpdatedAt` (KS-2699).
 *  - `broadcast:move` — короткий апдейт по одной игре после нового хода:
 *    `{roundId, gameIndex, uci, fen, whitePlayer, blackPlayer}`. Без
 *    clocks — следующий `sync` догонит, либо родитель сам решит
 *    запросить REST.
 *
 * Хук:
 *  1. Подключает глобальный `broadcastSocket` (если ещё не connected),
 *     emit `broadcast:subscribe` для `roundId`.
 *  2. Слушает `broadcast:sync` / `broadcast:move`, пробрасывает в
 *     callback'и через ref-обёртку — чтобы родитель мог менять
 *     замыкание (например, обновляться по последнему `gameId`) без
 *     re-subscribe.
 *  3. Возвращает `{connected}` для управления REST-fallback'ом
 *     (родитель запускает polling только пока WS не подключён).
 *  4. На unmount / смене `roundId` — emit `broadcast:unsubscribe` и
 *     снимает listener'ы. Сам socket НЕ disconnect'ится — он
 *     глобальный (`apps/web/src/socket.ts`), может использоваться
 *     несколькими страницами одновременно.
 */

export interface BroadcastSyncPayload {
  roundId: string;
  games: BroadcastGameSummary[];
}

export interface BroadcastMovePayload {
  roundId: string;
  gameIndex: number;
  uci: string;
  fen: string;
  whitePlayer?: string | null;
  blackPlayer?: string | null;
}

export interface UseBroadcastSocketArgs {
  /** ID раунда, на который подписываемся. null/undefined — хук «спит». */
  roundId: string | null | undefined;
  /** Callback на каждое сообщение `broadcast:sync` (initial + updates). */
  onSync?: (payload: BroadcastSyncPayload) => void;
  /** Callback на каждое сообщение `broadcast:move`. */
  onMove?: (payload: BroadcastMovePayload) => void;
}

export interface UseBroadcastSocketState {
  /**
   * `true` если socket.io connected И мы успели emit'нуть subscribe для
   * текущего `roundId`. Родитель использует флаг чтобы заглушить REST-
   * polling. На disconnect автоматически переходит в `false`,
   * polling-fallback в родителе включается.
   */
  connected: boolean;
}

export function useBroadcastSocket({
  roundId,
  onSync,
  onMove,
}: UseBroadcastSocketArgs): UseBroadcastSocketState {
  const [connected, setConnected] = useState(false);

  // Колбэки в ref — listener'ы могут жить дольше, чем замыкание родителя.
  const onSyncRef = useRef(onSync);
  const onMoveRef = useRef(onMove);
  useEffect(() => {
    onSyncRef.current = onSync;
  }, [onSync]);
  useEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);

  useEffect(() => {
    if (!roundId) {
      setConnected(false);
      return;
    }
    const s = broadcastSocket;

    const subscribe = () => {
      s.emit('broadcast:subscribe', { roundId });
      setConnected(true);
    };
    const handleConnect = () => subscribe();
    const handleDisconnect = () => setConnected(false);
    const handleSync = (payload: BroadcastSyncPayload) => {
      // Защита от cross-room сообщений: если родитель подписан только
      // на свой roundId, а сокет почему-то прислал чужой — игнорируем.
      if (payload?.roundId !== roundId) return;
      onSyncRef.current?.(payload);
    };
    const handleMove = (payload: BroadcastMovePayload) => {
      if (payload?.roundId !== roundId) return;
      onMoveRef.current?.(payload);
    };

    s.on('connect', handleConnect);
    s.on('disconnect', handleDisconnect);
    s.on('broadcast:sync', handleSync);
    s.on('broadcast:move', handleMove);

    if (s.connected) {
      // Уже подключены (другой компонент подключил раньше) — emit
      // subscribe сразу, не ждём `connect`-event.
      subscribe();
    } else {
      s.connect();
    }

    return () => {
      // Снимаем подписку для этого roundId (gateway убирает клиента
      // из room `broadcast:<roundId>`).
      try {
        s.emit('broadcast:unsubscribe', { roundId });
      } catch {
        /* socket мог упасть — игнорируем */
      }
      s.off('connect', handleConnect);
      s.off('disconnect', handleDisconnect);
      s.off('broadcast:sync', handleSync);
      s.off('broadcast:move', handleMove);
      // Не disconnect: глобальный broadcastSocket может быть
      // переиспользован другими страницами (CourseOutline live-pill,
      // BroadcastRoundPage и т.п.).
    };
  }, [roundId]);

  return { connected };
}
