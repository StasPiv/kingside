import { useContext, useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import { AuthContext } from '../context/AuthContext';

/**
 * KS-4805 / KS-4818 / ADR-153 §2.1. Refcount на shared-сокетах.
 *
 * До KS-4805 cleanup безусловно вызывал `s.disconnect()` — каждая
 * SPA-навигация рвала подключение. KS-4805 ввёл refcount, но смотрел
 * на токен через `localStorage.getItem('token')` синхронно в effect'е
 * с deps `[s, requireAuth]`. Если HintHost mount'ился раньше, чем
 * `AuthContext.fetchMe` дочитает токен (race на первой загрузке/SSR
 * hydrate/cold OAuth-callback), хук делал ранний выход без наложения
 * ref'а. HintHost тогда НЕ держал perm-ref'а, refcount колебался от
 * страницы к странице (Play unmount → 0 → disconnect → Game mount → 1
 * → новый socket.id), и room `user:<id>` пересоздавалась на каждый
 * SPA-переход — backend-self-emit `hint:show` уходил в пустоту на
 * проде (`engine_clients_total=0` на момент эмита, KS-4818).
 *
 * KS-4818: хук теперь подписан на `AuthContext.token`. Когда токен
 * появился (логин / refresh / OAuth-callback подтянул) — useEffect
 * пересчитывается и накладывает ref. Когда исчез (logout / sessions
 * expired) — cleanup отпускает ref. HintHost действительно держит
 * +1 ref на всю авторизованную сессию.
 *
 * Refcount — module-level `Map`. `disconnect()` вызывается только при
 * count → 0.
 */
const refCounts = new Map<Socket, number>();

/**
 * Lazily connect a socket.io socket on mount, disconnect on unmount —
 * с поддержкой shared-ownership через refcount и реакцией на смену
 * `AuthContext.token`.
 *
 * `requireAuth=true` (default) — без токена в `AuthContext` хук
 * пропускает подключение и не накладывает ref. Когда токен появится,
 * useEffect пересчитается и подсоединит. `requireAuth=false` — для
 * гостевых сокетов (`/broadcast`, `/spectate`) — игнорирует токен,
 * подключается сразу.
 *
 * Зависит от того, что вызывающий компонент находится внутри
 * `<AuthProvider>` — иначе useAuth() контекст пустой. В проекте
 * AuthProvider стоит в корне (`apps/web/src/main.tsx`), все
 * use-sites useLazySocket — под ним.
 */
export function useLazySocket(s: Socket, requireAuth = true) {
  // KS-4818: токен через AuthContext, а не localStorage. Effect ниже
  // включает `token` в deps — при смене токена хук перенакладывает ref
  // и (при необходимости) реконнектит с новой авторизацией. Если
  // компонент рендерится вне `<AuthProvider>` (теоретически), Context
  // вернёт `null` — трактуем как guest (token=null).
  const ctx = useContext(AuthContext);
  const token = ctx?.token ?? null;

  useEffect(() => {
    if (requireAuth && !token) {
      // KS-4818: видимый в DevTools лог. Если у пользователя на проде в
      // момент жалобы в консоли висит «skip (no token)» — значит причина
      // race с AuthContext (что уже не должно быть после fix'а, но для
      // регрессии и доказательства корня нужно зафиксировать).
      // eslint-disable-next-line no-console
      console.warn('[useLazySocket] skip mount — no token in AuthContext', {
        ns: (s as { nsp?: string }).nsp,
      });
      return;
    }
    s.auth = token ? { token } : {};

    const next = (refCounts.get(s) ?? 0) + 1;
    refCounts.set(s, next);
    // eslint-disable-next-line no-console
    console.warn('[useLazySocket] mount ref+1', {
      ns: (s as { nsp?: string }).nsp,
      refcount: next,
      connected: s.connected,
    });
    if (!s.connected) {
      s.connect();
    }

    return () => {
      const after = (refCounts.get(s) ?? 1) - 1;
      // eslint-disable-next-line no-console
      console.warn('[useLazySocket] cleanup ref-1', {
        ns: (s as { nsp?: string }).nsp,
        refcount: after,
        willDisconnect: after <= 0,
      });
      if (after <= 0) {
        refCounts.delete(s);
        s.disconnect();
      } else {
        refCounts.set(s, after);
      }
    };
  }, [s, requireAuth, token]);
}
