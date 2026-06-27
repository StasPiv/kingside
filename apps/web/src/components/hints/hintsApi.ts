import type { HintLifecycleKind, HintLifecycleReason } from '@kingside/shared';

const API_BASE =
  (import.meta.env?.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';

/**
 * KS-4703 / ADR-147 §4.3. Шлёт `POST /hints/:hintId/{kind}` с
 * опциональным `{reason}`. Для авторизованного — `Authorization`
 * Bearer; для гостя — `credentials:'include'` (cookie `guest_id`).
 *
 * Возвращает `true` при HTTP 2xx, иначе `false`. Ошибки не пробрасывает —
 * lifecycle вспомогательный, ронять UI из-за него нельзя.
 */
export async function sendHintLifecycle(params: {
  hintId: string;
  kind: HintLifecycleKind;
  reason?: HintLifecycleReason | null;
  token: string | null;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const { hintId, kind, reason, token } = params;
  const f = params.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  if (!f) return false;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const res = await f(`${API_BASE}/hints/${hintId}/${kind}`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(reason ? { reason } : {}),
    });
    return res.ok;
  } catch {
    return false;
  }
}
