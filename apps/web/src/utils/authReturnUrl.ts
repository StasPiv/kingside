/**
 * KS-2110: переживающий OAuth-редирект returnUrl.
 *
 * Поток:
 *   1. ProtectedRoute редиректит неавторизованного на `/login`,
 *      одновременно сохраняя `pathname+search` в sessionStorage.
 *   2. На `/login` пользователь жмёт OAuth (Google/Facebook):
 *      `window.location.href = '/auth/google'` уносит браузер на
 *      бекенд → внешний провайдер → callback на `/oauth/callback`.
 *      В react-router state не выживает — нужен sessionStorage.
 *   3. После успешного логина (Telegram внутри SPA, OAuth callback,
 *      username-setup) читаем сохранённое значение и navigate туда.
 *      Дальше — удаляем (одноразово), чтобы при следующем заходе на
 *      /login без `?returnUrl` пользователя не утянуло обратно.
 *
 * Использование `sessionStorage` (а не `localStorage`) намеренное:
 *   • живёт до закрытия вкладки;
 *   • не утечёт между разными окнами/устройствами;
 *   • после успешного login и `consume`'а уйдёт сразу.
 */

const KEY = 'authReturnUrl:v1';

/**
 * Списки путей, на которые ВОЗВРАЩАТЬ нельзя — иначе закольцуем
 * пользователя обратно на login после успеха.
 */
const FORBIDDEN_PREFIXES = ['/login', '/register', '/oauth/callback'];

function isAllowed(path: string | null): path is string {
  if (!path) return false;
  if (!path.startsWith('/')) return false;
  for (const p of FORBIDDEN_PREFIXES) {
    if (path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`)) {
      return false;
    }
  }
  return true;
}

export function setAuthReturnUrl(path: string): void {
  if (!isAllowed(path)) return;
  try {
    sessionStorage.setItem(KEY, path);
  } catch {
    // sessionStorage может быть недоступен (private mode + всякие
    // ограничения) — не валим UI.
  }
}

/**
 * Читает и удаляет returnUrl. Если значение не прошло проверку
 * `isAllowed` (испорчено / лежит '/login') — возвращает null,
 * и потребитель уйдёт на свой дефолт.
 */
export function consumeAuthReturnUrl(): string | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  return isAllowed(raw) ? raw : null;
}

/**
 * Без удаления — для GuestRoute, который должен принять решение
 * куда отправлять уже залогиненного, но не «съесть» сохранённый
 * returnUrl до того, как реальный логин-обработчик его прочитает.
 */
export function peekAuthReturnUrl(): string | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
  return isAllowed(raw) ? raw : null;
}
