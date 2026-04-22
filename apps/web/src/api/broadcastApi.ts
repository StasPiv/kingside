import { ApiError } from '../ApiError';
import { BROADCAST_URL } from '../config/broadcastUrl';

/**
 * HTTP-клиент для broadcast-service (broadcasts.kingside.site).
 *
 * Паттерн повторяет `apps/web/src/api.ts`, но без refresh-токен логики —
 * broadcasts endpoints публичные (ADR-021 §2), auth не требуется.
 * При необходимости future endpoints могут потребовать токен, поэтому
 * Bearer прокидывается если есть в localStorage.
 *
 * Используется для (KS-1702: префикс /broadcasts удалён, субдомен уже выражает domain):
 *  - GET /               — список
 *  - GET /:id            — мета
 *  - GET /:id/rounds
 *  - GET /:id/rounds/:roundId/games
 *  - GET /:id/standings
 */

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options?.headers as Record<string, string>) ?? {}),
  };
  if (token && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BROADCAST_URL}${path}`, { ...options, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.message ?? `Request failed: ${res.status}`, body.errorCode);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json();
}

export const broadcastApi = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body), headers }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
