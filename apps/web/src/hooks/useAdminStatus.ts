import { useEffect, useState } from 'react';

import { configApi } from '../api/configApi';
import { useAuth } from '../context/AuthContext';

/**
 * KS-2109 — статус админа для текущего пользователя.
 *
 * Источник — `GET /profile/me/admin-status` (KS-2108). Список админов
 * на бэке — env-переменная `KS_ADMIN_USERS` (whitelist по username).
 *
 * # Поведение
 *
 *  - Гость (`user === null`) → `{ isAdmin: false, loading: false }`,
 *    запрос не уходит. Так Sidebar не показывает «Админку», а
 *    `/admin/*` редиректит сразу.
 *  - Аутентифицированный — на mount грузим статус один раз. После
 *    смены пользователя (`user.id` изменился) перезапрашиваем.
 *  - Ошибка эндпоинта → `isAdmin: false` (безопасный фолбэк, скрываем).
 *
 * # Не использовать для авторизации серверных операций
 *
 * UI скрытие — это эстетика, не security. Реальная защита — гард
 * на бэке (`AdminUserGuard` в KS-2108). Если фронт ошибся в трактовке
 * `isAdmin`, бэк всё равно вернёт 403 на admin-эндпоинты.
 */
export interface UseAdminStatusReturn {
  isAdmin: boolean;
  loading: boolean;
}

export function useAdminStatus(): UseAdminStatusReturn {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [isAdmin, setIsAdmin] = useState(false);
  // `fetchedFor` хранит userId, для которого уже пришёл ответ. Пока
  // не равен текущему userId — считаем что мы ещё «загружаем». Это
  // важно, потому что между переходом authLoading=true→false и
  // запуском нашего useEffect есть один React-рендер. Если бы мы
  // только использовали `loading: useState(false)`, AdminRoute на
  // этом промежуточном рендере увидел бы `isAdmin: false, loading: false`
  // и сделал бы редирект — даже у настоящего админа.
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) {
      setIsAdmin(false);
      setFetchedFor(null);
      return;
    }
    let cancelled = false;
    configApi
      .getAdminStatus()
      .then((res) => {
        if (cancelled) return;
        setIsAdmin(Boolean(res.isAdmin));
      })
      .catch(() => {
        if (cancelled) return;
        // Скрываем admin-UI если эндпоинт упал — пользователь не
        // должен видеть «Админку» из-за сетевой ошибки. Реальная
        // авторизация — на бэке.
        setIsAdmin(false);
      })
      .finally(() => {
        if (!cancelled) setFetchedFor(userId);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // loading=true пока:
  //  • есть userId (залогинены), и
  //  • для этого userId ещё не пришёл ответ admin-status.
  const loading = userId !== null && fetchedFor !== userId;

  return { isAdmin, loading };
}
