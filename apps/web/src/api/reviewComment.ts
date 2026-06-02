/**
 * KS-3616 / ADR-102 §7 этап C. Клиент `POST /api/analysis-review/comments`.
 *
 * Графс-degradation: при любой ошибке backend'a (5xx, 429, invalid JSON,
 * network) возвращаем массив пустых строк длиной = facts.length —
 * вызывающий код штатно собирает PGN без `{}` и показывает toast.
 * Исключение — `AbortError` (cancel): пробрасываем, чтобы хук завершил
 * `status='cancelled'`.
 *
 * Авторизация — Bearer из localStorage (паттерн `archive.ts` —
 * глобальный `api.ts` не передаёт `signal`, нам он нужен для cancel).
 */
import type { FactsInput } from '../lib/review/extractFacts';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  try {
    const token =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem('token')
        : null;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch {
    /* localStorage недоступен в SSR-тестах */
  }
  return headers;
}

function emptyComments(n: number): string[] {
  return new Array(n).fill('');
}

export async function batchReviewComment(
  facts: readonly FactsInput[],
  userElo: number,
  language: 'en' | 'ru',
  signal?: AbortSignal,
): Promise<string[]> {
  if (facts.length === 0) return [];

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/analysis-review/comments`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ facts, userElo, language }),
      signal,
    });
  } catch (e) {
    // `AbortError` — единственное, что пробрасываем (cancel сверху).
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    if (
      typeof Error !== 'undefined' &&
      e instanceof Error &&
      e.name === 'AbortError'
    ) {
      throw e;
    }
    // Network/CORS/DNS — graceful.
    return emptyComments(facts.length);
  }

  if (!res.ok) return emptyComments(facts.length);

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return emptyComments(facts.length);
  }

  const comments = (data as { comments?: unknown } | null)?.comments;
  if (!Array.isArray(comments)) return emptyComments(facts.length);

  // Нормализуем: каждый элемент → строка (если не строка — пустая).
  return comments.map((c) => (typeof c === 'string' ? c : ''));
}
