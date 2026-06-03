/**
 * KS-3616 / ADR-102 §7 этап C — клиент `POST /analyses/review/comments`.
 * KS-3629 — чанкование батча для устойчивости к длинным партиям.
 *
 * Большие партии (60+ NAG-ходов) раньше падали целиком при любой
 * валидации/лимите на бэке. Теперь батч делится на чанки и шлётся
 * с ограниченной concurrency. Если один чанк упал — остальные доходят
 * и заполняют свои позиции, упавший — пустыми строками. AbortController
 * один на все запросы: cancel валит всё разом.
 *
 * Graceful (как было): любая нефатальная ошибка → пустые строки в
 * результате, вызывающий код собирает PGN без `{}` и показывает toast.
 * `AbortError` пробрасывается, чтобы хук завершил `status='cancelled'`.
 */
import type { FactsInput } from '../lib/review/extractFacts';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

/** Размер одного чанка (фактов в запросе). По умолчанию 25 — с запасом
 *  под прежний лимит DTO `@ArrayMaxSize(40)` и под LLM-context Claude. */
export const DEFAULT_CHUNK_SIZE = 25;

/** Сколько чанков шлём параллельно. По умолчанию 3 — не съедает
 *  rate-limit бэка (10/мин per user) за один разбор и не перегружает
 *  Claude rate per minute. */
export const DEFAULT_CONCURRENCY = 3;

export interface BatchReviewCommentOptions {
  chunkSize?: number;
  concurrency?: number;
  /** Тик по завершении каждого чанка: `done` — кумулятивное число
   *  обработанных фактов (вне зависимости от того, вернул чанк
   *  непустые строки или нет). Используется для прогресс-бара. */
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

function emptyComments(n: number): string[] {
  return new Array(n).fill('');
}

function isAbortError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'AbortError') return true;
  if (e instanceof Error && e.name === 'AbortError') return true;
  return false;
}

/**
 * Один POST с порцией facts. Возвращает массив строк длиной = facts.length:
 *   - успех: нормализованные комментарии (LLM trim → паддинг пустыми);
 *   - 4xx/5xx/network/парс: массив пустых строк (graceful);
 *   - abort: пробрасывает AbortError.
 */
async function sendChunk(
  facts: readonly FactsInput[],
  userElo: number,
  language: 'en' | 'ru',
  signal: AbortSignal | undefined,
): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/analyses/review/comments`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ facts, userElo, language }),
      signal,
    });
  } catch (e) {
    if (isAbortError(e)) throw e;
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

  // Нормализуем + паддинг до длины чанка (LLM мог вернуть меньше).
  const out = new Array<string>(facts.length).fill('');
  for (let i = 0; i < Math.min(comments.length, facts.length); i++) {
    const c = comments[i];
    out[i] = typeof c === 'string' ? c : '';
  }
  return out;
}

/**
 * Резка `arr` на куски по `size`. Сохраняет порядок.
 */
export function chunkFacts<T>(arr: readonly T[], size: number): T[][] {
  if (size <= 0) return [arr.slice() as T[]];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size) as T[]);
  }
  return out;
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

export async function batchReviewComment(
  facts: readonly FactsInput[],
  userElo: number,
  language: 'en' | 'ru',
  signal?: AbortSignal,
  options?: BatchReviewCommentOptions,
): Promise<string[]> {
  if (facts.length === 0) return [];

  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  const onProgress = options?.onProgress;

  const chunks = chunkFacts(facts, chunkSize);
  // Параллельно тяжёлый массив переиспользуем как буфер ответа,
  // склейка строго по индексам исходных facts.
  const result = new Array<string>(facts.length).fill('');
  let cumulativeDone = 0;

  const tasks = chunks.map((chunk, chunkIdx) => async () => {
    const startIdx = chunkIdx * chunkSize;
    const out = await sendChunk(chunk, userElo, language, signal);
    for (let i = 0; i < out.length; i++) {
      result[startIdx + i] = out[i];
    }
    cumulativeDone += chunk.length;
    onProgress?.(cumulativeDone);
  });

  try {
    await runWithConcurrency(tasks, concurrency);
  } catch (e) {
    if (isAbortError(e)) throw e;
    // Не должно прилетать — sendChunk сам graceful. Защита от регрессии.
    return emptyComments(facts.length);
  }
  return result;
}
