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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options?.headers as Record<string, string>) ?? {}),
  };
  if (token && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetchWithTimeout(
    `${API_URL}${path}`,
    { ...options, headers },
    REQUEST_TIMEOUT_MS,
  );

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
        throw new ApiError(
          body.message ?? `Request failed: ${retry.status}`,
          body.errorCode,
          retry.status,
        );
      }
      return retry.json();
    } catch (e) {
      // KS-2351: не глотать таймаут refresh'а как «session expired» —
      // UI должен видеть `REQUEST_TIMEOUT`/`NETWORK_ERROR` отдельно от
      // реального истечения сессии, чтобы предложить retry, а не редирект на login.
      if (e instanceof ApiError) throw e;
      throw new Error('Session expired');
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
  get: <T>(path: string) => request<T>(path),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
