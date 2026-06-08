import { ApiError } from './ApiError';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

/**
 * KS-2351: глобальный timeout всех запросов. Без него зависший
 * Service Worker / proxy / interceptor оставлял Promise навсегда в
 * pending — фронт не мог откатить состояние (`submitting=true`),
 * пользователь думал что страница сломана. 15с — компромисс между
 * долгими сетевыми операциями (загрузка lichess-puzzle JSON) и
 * детектом действительно зависших соединений.
 *
 * При срабатывании AbortController fetch бросает DOMException
 * `AbortError`. Перехватываем и нормализуем в `ApiError(..., undefined, 0)`
 * с `errorCode='REQUEST_TIMEOUT'`, чтобы вызывающий код мог отличить
 * timeout от 4xx/5xx по `e.errorCode`.
 */
const REQUEST_TIMEOUT_MS = 15_000;

let refreshPromise: Promise<string> | null = null;

/**
 * KS-3333. Single-source — сообщаем приложению что сессия истекла.
 * AuthContext подписан на `kingside:session-expired` и выполняет
 * cleanup tokens + redirect на /login (с сохранением returnUrl).
 *
 * Используем CustomEvent а не прямой импорт AuthContext'a — `api.ts`
 * находится в module-scope, React-context оттуда недоступен. Event
 * decoupling также удобен для тестов и для повторного использования
 * из других слоёв (websocket-gateway тоже может триггерить).
 *
 * Защита от спама: один dispatch за tick (если 401-ов несколько
 * параллельно, все попадают в catch, но обработчик внутри AuthContext
 * идемпотентен — повторный logout/redirect не вредит).
 */
function notifySessionExpired(): void {
  if (typeof window === 'undefined') return;
  try {
    const here = window.location.pathname + window.location.search;
    // Сохраняем returnUrl только если юзер не на /login (иначе
    // зациклимся: logout → /login → logout → /login). Sessionstorage —
    // тот же ключ что использует `setAuthReturnUrl`/`consumeAuthReturnUrl`
    // (см. utils/authReturnUrl.ts).
    if (!here.startsWith('/login') && !here.startsWith('/register')) {
      sessionStorage.setItem('authReturnUrl', here);
    }
  } catch {
    /* sessionStorage недоступен — не критично, пользователь после
       логина просто попадёт на главную. */
  }
  window.dispatchEvent(new CustomEvent('kingside:session-expired'));
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  // Если caller уже передал signal — связываем оба, чтобы ни один
  // источник отмены не потерялся.
  if (init?.signal) {
    if (init.signal.aborted) controller.abort();
    init.signal.addEventListener('abort', () => controller.abort());
  }
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError(
        'Request timed out',
        'REQUEST_TIMEOUT',
        0,
      );
    }
    // Сетевые ошибки (CORS / connection refused / DNS) → fetch кидает
    // TypeError. Нормализуем в ApiError со статусом 0 и кодом
    // NETWORK_ERROR — UI показывает «Сервер не отвечает» вместо generic.
    if (e instanceof TypeError) {
      throw new ApiError(
        e.message || 'Network error',
        'NETWORK_ERROR',
        0,
      );
    }
    throw e;
  } finally {
    clearTimeout(id);
  }
}

async function refreshAccessToken(): Promise<string> {
  const refreshToken = localStorage.getItem('refreshToken');
  if (!refreshToken) throw new Error('No refresh token');

  // KS-2351: refresh тоже под таймаутом — иначе интерсептор может
  // навсегда зависнуть, если /auth/refresh не отвечает.
  const res = await fetchWithTimeout(
    `${API_URL}/auth/refresh`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    },
    REQUEST_TIMEOUT_MS,
  );

  if (!res.ok) {
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    throw new Error('Refresh failed');
  }

  const data = await res.json();
  localStorage.setItem('token', data.accessToken);
  localStorage.setItem('refreshToken', data.refreshToken);
  return data.accessToken;
}

/**
 * KS-3547: телеметрия для расследования таймаутов на старте сессий
 * (blind-board, guess). Логи `performance.now()` помогают понять,
 * сколько времени ушло на сам fetch vs network — при следующем
 * инциденте можно сопоставить с ALB-логами.
 *
 * Активируется ТОЛЬКО для конкретных «горячих» эндпоинтов, чтобы не
 * засорять консоль обычным трафиком. Перечень минимальный, расширяем
 * только когда есть жалоба.
 */
const TELEMETRY_PATHS: ReadonlySet<string> = new Set([
  '/blind-board/sessions',
  '/guess/sessions',
]);

function isTelemetryRequest(path: string, method: string): boolean {
  if (method !== 'POST') return false;
  // Берём первую сегмент-цепочку до query/params.
  const clean = path.split('?')[0];
  // Точное совпадение без trailing-id — старт сессии (POST /sessions),
  // не submit/finish (POST /sessions/:id/...).
  return TELEMETRY_PATHS.has(clean);
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options?.headers as Record<string, string>) ?? {}),
  };
  if (token && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // KS-3547: тайминги для «горячих» POST'ов.
  const method = options?.method ?? 'GET';
  const isTelemetry = isTelemetryRequest(path, method);
  const t0 = isTelemetry ? performance.now() : 0;

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${API_URL}${path}`,
      { ...options, headers },
      REQUEST_TIMEOUT_MS,
    );
    if (isTelemetry) {
      // eslint-disable-next-line no-console
      console.info(
        `[telemetry] ${method} ${path} ok status=${res.status} ` +
          `fetch=${Math.round(performance.now() - t0)}ms ` +
          `sw=${typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller}`,
      );
    }
  } catch (e) {
    if (isTelemetry) {
      const code = e instanceof ApiError ? e.errorCode : 'UNKNOWN';
      // eslint-disable-next-line no-console
      console.warn(
        `[telemetry] ${method} ${path} FAILED code=${code} ` +
          `elapsed=${Math.round(performance.now() - t0)}ms ` +
          `sw=${typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller} ` +
          `online=${typeof navigator !== 'undefined' ? navigator.onLine : 'n/a'}`,
        e,
      );
    }
    throw e;
  }

  if (res.status === 401 && !path.includes('/auth/refresh') && !path.includes('/auth/login') && !path.includes('/auth/register')) {
    if (!refreshPromise) {
      refreshPromise = refreshAccessToken().finally(() => { refreshPromise = null; });
    }
    try {
      const newToken = await refreshPromise;
      headers['Authorization'] = `Bearer ${newToken}`;
      const retry = await fetchWithTimeout(
        `${API_URL}${path}`,
        { ...options, headers },
        REQUEST_TIMEOUT_MS,
      );
      if (!retry.ok) {
        const body = await retry.json().catch(() => ({}));
        // KS-3333: повтор после refresh всё ещё 401 → session реально
        // невалидна (например, refresh-token валиден, но access-token
        // запретили). Триггерим тот же session-expired flow.
        if (retry.status === 401) {
          notifySessionExpired();
          throw new ApiError(
            body.message ?? 'Session expired',
            'SESSION_EXPIRED',
            401,
          );
        }
        throw new ApiError(
          body.message ?? `Request failed: ${retry.status}`,
          body.errorCode,
          retry.status,
        );
      }
      return retry.json();
    } catch (e) {
      // KS-3464 (ревизия KS-2351): REQUEST_TIMEOUT/NETWORK_ERROR
      // ВНУТРИ refresh-flow трактуем как session-expired — иначе
      // пользователь застревает на странице с протухшим access-token
      // и retry'ит запросы вечно (каждый раз 15s timeout, нет
      // редиректа). Если refresh-token валиден и /auth/refresh упал
      // временно — после редиректа на /login юзер тут же логинется
      // снова, потеря небольшая. SESSION_EXPIRED это допустимый
      // компромисс: лучше показать «логин» один раз, чем зависать
      // навсегда. ApiError с другими статусами (включая 401 от
      // retry'нутого endpoint'а — обработан в блоке выше через
      // `retry.status === 401`) — пробрасываем как было.
      const isTransientApiError =
        e instanceof ApiError &&
        (e.errorCode === 'REQUEST_TIMEOUT' || e.errorCode === 'NETWORK_ERROR');
      if (e instanceof ApiError && !isTransientApiError) throw e;
      // KS-3333: refreshAccessToken упал (refresh-token истёк или сам
      // /auth/refresh вернул не-2xx) — либо KS-3464 транзиентная
      // ошибка внутри refresh. В обоих случаях:
      //   1. Сохраняем текущий URL в sessionStorage (через util
      //      `setAuthReturnUrl` подключенный к LoginPage flow).
      //   2. Диспатчим CustomEvent 'kingside:session-expired'.
      //      AuthContext подписан и сделает: clear tokens + state.user=null
      //      + redirect на /login.
      //   3. Бросаем ApiError со специальным errorCode='SESSION_EXPIRED' —
      //      вызывающие места (openAnalysis catch и т.п.) могут отличить
      //      этот случай и не показывать alert поверх редиректа.
      notifySessionExpired();
      throw new ApiError('Session expired', 'SESSION_EXPIRED', 401);
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      body.message ?? `Request failed: ${res.status}`,
      body.errorCode,
      res.status,
    );
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json();
}

export const api = {
  post: <T>(path: string, body: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body), headers }),
  /**
   * KS-3894: опциональный `init` — пока поддержан только `signal`
   * (AbortSignal) для отмены запроса при смене фильтра в каталоге
   * пазлов. Чтобы не ломать существующие вызовы, сигнатура осталась
   * с двумя позиционными параметрами; init опционален.
   */
  get: <T>(path: string, init?: { signal?: AbortSignal }) =>
    request<T>(path, init?.signal ? { signal: init.signal } : undefined),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
