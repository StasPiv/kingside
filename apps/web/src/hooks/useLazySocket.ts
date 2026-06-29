import { useEffect } from 'react';
import type { Socket } from 'socket.io-client';

/**
 * KS-4805 / ADR-153 §2.1. Refcount на shared-сокетах.
 *
 * До правки cleanup безусловно вызывал `s.disconnect()` — это создавало
 * гонку, когда страница, использующая `messagesSocket` (PlayPage,
 * MessagesPage, FriendsPage, GamePage), unmount'илась, а HintHost / другие
 * подписчики продолжали ожидать room `user:<id>` живой. В окно «disconnect
 * → handshake» backend-self-emit'ы (`hint:show` для `analyze-after-loss`)
 * уходили в пустую room и дропались Socket.IO.
 *
 * Refcount хранится в module-level Map: ключ — сам socket-объект. Cleanup
 * вызывает `disconnect()` только когда счётчик достиг 0. `HintHost`
 * mount'ится в `MainLayout` один раз на всю авторизованную сессию и
 * держит +1 ref непрерывно — поэтому room никогда не пустеет.
 *
 * При logout `<HintHost>` unmount → ref снят → другие страницы тоже
 * обычно unmount'ились (логаут редиректит) → счётчик 0 → disconnect.
 */
const refCounts = new Map<Socket, number>();

/**
 * Lazily connect a socket.io socket on mount, disconnect on unmount —
 * с поддержкой shared-ownership через refcount.
 *
 * If requireAuth is true (default), skips connection when no JWT token is
 * available; в этом случае ref не накладывается (гость не должен
 * блокировать disconnect для других подписчиков).
 */
export function useLazySocket(s: Socket, requireAuth = true) {
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (requireAuth && !token) return;
    s.auth = token ? { token } : {};

    refCounts.set(s, (refCounts.get(s) ?? 0) + 1);
    if (!s.connected) {
      s.connect();
    }

    return () => {
      const next = (refCounts.get(s) ?? 1) - 1;
      if (next <= 0) {
        refCounts.delete(s);
        s.disconnect();
      } else {
        refCounts.set(s, next);
      }
    };
  }, [s, requireAuth]);
}
