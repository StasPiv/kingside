/**
 * Клиент `POST /analyses/position/comment` — комментарий к одной позиции
 * по списку позиционных факторов (`PositionalSubterm[]`, как отдаёт
 * `evalTrace` / `window.__sfTrace`).
 *
 * Контракт обработчика:
 *   Запрос:  { fen: string, factors: PositionalSubterm[] }
 *   Ответ:   { comment: string }   // "" — штатное снижение при сбое модели
 *   Заголовки: Authorization: Bearer <jwt>, Content-Type: application/json
 *
 * Снаружи функция сохраняет старую сигнатуру `batchReviewComment(facts, …)`
 * → `string[]`, чтобы не ломать `useGameReview` и `window.__sfReviewProbe`.
 * Внутри теперь N независимых запросов с ограничением параллелизма —
 * новый обработчик принимает по одной позиции за вызов.
 *
 * Graceful: любая нефатальная ошибка (4xx/5xx/network/парс) → пустая
 * строка в соответствующей позиции. `AbortError` пробрасывается, чтобы
 * вызывающий хук завершился `status='cancelled'`.
 */
import type { PositionalSubterm } from '@kingside/shared';

import type { FactsInput } from '../lib/review/extractFacts';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

/** Сколько позиций шлём параллельно. 3 — компромисс между скоростью
 *  разбора и ограничением запросов на стороне backend (20/мин). */
export const DEFAULT_CONCURRENCY = 3;

/** Совместимость со старой опцией. Новый обработчик принимает позицию
 *  по одной, поэтому значение не используется. Оставлено в типе, чтобы
 *  не ломать вызывающий код. */
export const DEFAULT_CHUNK_SIZE = 1;

export interface BatchReviewCommentOptions {
  /** Не используется новым обработчиком (одна позиция за запрос),
   *  оставлено для обратной совместимости сигнатуры. */
  chunkSize?: number;
  concurrency?: number;
  /** Тик по завершении каждой позиции: `done` — кумулятивное число
   *  обработанных фактов. Используется для прогресс-бара. */
  onProgress?: (done: number) => void;
}

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

function isAbortError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'AbortError') return true;
  if (e instanceof Error && e.name === 'AbortError') return true;
  return false;
}

/**
 * Один POST `/analyses/position/comment` для одной позиции. Возвращает
 * строку-комментарий (пустую при любой нефатальной ошибке). `AbortError`
 * пробрасывается.
 */
async function sendOne(
  fen: string,
  factors: readonly PositionalSubterm[],
  signal: AbortSignal | undefined,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/analyses/position/comment`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fen, factors }),
      signal,
    });
  } catch (e) {
    if (isAbortError(e)) throw e;
    return '';
  }

  if (!res.ok) return '';

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return '';
  }

  const comment = (data as { comment?: unknown } | null)?.comment;
  return typeof comment === 'string' ? comment : '';
}

/**
 * Запуск `tasks` параллельно с ограничением concurrency. Сохраняет
 * порядок выходного массива по индексу задачи. AbortError из любой
 * задачи пробрасывается наверх (вся выборка немедленно прерывается).
 */
async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let nextIdx = 0;
  const workersCount = Math.max(1, Math.min(limit, tasks.length));
  const workers = Array.from({ length: workersCount }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]();
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Для каждого факта берёт `fen` и `positional_subterms` и шлёт отдельный
 * запрос на `/analyses/position/comment`. Возвращает массив комментариев
 * длиной = `facts.length`. Сохраняет старую сигнатуру ради совместимости
 * с `useGameReview` и dev-tool `window.__sfReviewProbe`.
 *
 * Параметры `userElo` и `language` оставлены в сигнатуре для совместимости
 * вызовов, но новым обработчиком не используются: контракт нового
 * обработчика — только `{ fen, factors }`.
 */
export async function batchReviewComment(
  facts: readonly FactsInput[],
  _userElo: number,
  _language: 'en' | 'ru',
  signal?: AbortSignal,
  options?: BatchReviewCommentOptions,
): Promise<string[]> {
  if (facts.length === 0) return [];

  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  const onProgress = options?.onProgress;

  const result = new Array<string>(facts.length).fill('');
  let cumulativeDone = 0;

  const tasks = facts.map((fact, idx) => async () => {
    const factors = Array.isArray(fact.positional_subterms)
      ? fact.positional_subterms
      : [];
    const out = await sendOne(fact.fen, factors, signal);
    result[idx] = out;
    cumulativeDone += 1;
    onProgress?.(cumulativeDone);
  });

  try {
    await runWithConcurrency(tasks, concurrency);
  } catch (e) {
    if (isAbortError(e)) throw e;
    // Не должно прилетать — sendOne сам graceful. Защита от регрессии.
    return new Array<string>(facts.length).fill('');
  }
  return result;
}
