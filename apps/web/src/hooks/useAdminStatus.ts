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
 * # KS-2919: fallback по username
 *
 * Пункт «Админка» пропадал у Stanislav в обоих контейнерах (Sidebar +
 * MobileBottomBar) при том, что код-уровень гейтов корректен и тесты
 * зелёные. Причина — runtime: `/profile/me/admin-status` возвращал
 * `isAdmin: false`, потому что `KS_ADMIN_USERS` на бэке указывает
 * на конкретный username (см. `scripts/deploy-aws.sh` →
 * `KS_ADMIN_USERS=StanislavTelegram`), а реальный логин у пользователя
 * мог разойтись (или эндпоинт временно недоступен). На стороне UI это
 * выглядит как «регрессия» (кнопка пропала после деплоя), хотя в коде
 * правила видимости не менялись.
 *
 * Поэтому добавлен defensive-fallback: если бэк сказал «нет» (или
 * упал), и при этом `user.username` входит в FRONTEND_ADMIN_WHITELIST
 * (зеркало `KS_ADMIN_USERS` из deploy-скрипта) — UI всё равно показывает
 * админ-пункт. Это влияет ТОЛЬКО на видимость кнопки. Реальные
 * admin-эндпоинты по-прежнему защищены гардом на бэке: если фронт
 * ошибётся и покажет кнопку не-админу, запрос вернёт 403, а не
 * откроет доступ.
 *
 * Whitelist намеренно держим маленьким и явным. Когда `KS_ADMIN_USERS`
 * на проде меняется — обновлять и здесь. Альтернатива (правильнее в
 * долгосрочной перспективе) — отдавать `isAdmin` в `/auth/me`
 * и убрать отдельный `/profile/me/admin-status` + этот fallback;
 * это отдельная backend-задача.
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

/**
 * KS-2919 / KS-2921: зеркало `KS_ADMIN_USERS` из `scripts/deploy-aws.sh`.
 * Совпадение по строгому равенству username. Используется только как
 * fallback для видимости UI-кнопки; backend-гард не отключаем.
 *
 * KS-2921: значение приведено к реальному username админа `Stanislav`
 * (синхронно с KS-2920, где правится `KS_ADMIN_USERS` в deploy-скрипте).
 * Раньше здесь стоял `StanislavTelegram`, потому что предыдущий env-файл
 * содержал именно эту строку — но фактический логин админа в БД иной.
 */
const FRONTEND_ADMIN_WHITELIST: ReadonlyArray<string> = ['Stanislav'];

function isWhitelistedAdmin(username: string | undefined | null): boolean {
  if (!username) return false;
  return FRONTEND_ADMIN_WHITELIST.includes(username);
}

export function useAdminStatus(): UseAdminStatusReturn {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const whitelistMatch = isWhitelistedAdmin(user?.username);
  const [backendIsAdmin, setBackendIsAdmin] = useState(false);
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
      setBackendIsAdmin(false);
      setFetchedFor(null);
      return;
    }
    let cancelled = false;
    configApi
      .getAdminStatus()
      .then((res) => {
        if (cancelled) return;
        setBackendIsAdmin(Boolean(res.isAdmin));
      })
      .catch(() => {
        if (cancelled) return;
        // Скрываем admin-UI если эндпоинт упал — пользователь не
        // должен видеть «Админку» из-за сетевой ошибки. Реальная
        // авторизация — на бэке.
        setBackendIsAdmin(false);
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
  // Если username уже в whitelist — loading=false сразу (мы уже знаем
  // ответ, ждать бэк не нужно для UI-видимости).
  const loading =
    !whitelistMatch && userId !== null && fetchedFor !== userId;

  // KS-2919: финальный флаг — OR между бэком и frontend-whitelist'ом.
  // Whitelist'у достаточно, чтобы показать пункт в UI.
  const isAdmin = backendIsAdmin || whitelistMatch;

  return { isAdmin, loading };
}
