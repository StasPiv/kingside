/**
 * KS-2017 / B-1 — клиент к admin-эндпоинту `POST /lessons/admin/import`
 * (B-3, KS-2018). Пока B-3 не реализован, метод возвращает детальную
 * заглушку с понятным сообщением — CLI-обёртка распечатает её и
 * остановится. См. ADR §5.1.
 *
 * Контракт endpoint'а (черновой, фиксируется в B-3):
 *
 *   POST /lessons/admin/import
 *   Authorization: Bearer <admin token>
 *   Body: { course?: CourseFileData, lesson: LessonFileData, dryRun?: boolean }
 *   200: { course: ..., lesson: ..., steps: [...] }
 */

import type { ParsedBundle } from './types.js';

export interface UpsertOptions {
  baseUrl: string;
  token?: string;
  dryRun?: boolean;
}

export interface UpsertResult {
  status: 'ok' | 'not_implemented' | 'error';
  message?: string;
  raw?: unknown;
}

export async function upsertBundle(
  bundle: ParsedBundle,
  opts: UpsertOptions,
): Promise<UpsertResult[]> {
  const url = joinUrl(opts.baseUrl, '/lessons/admin/import');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const results: UpsertResult[] = [];
  // По одному уроку на запрос: проще удерживать атомарность одного урока
  // в одной транзакции (см. ADR §5.2).
  for (const lesson of bundle.lessons) {
    const body = JSON.stringify({
      course: bundle.course?.data,
      lesson: lesson.data,
      dryRun: opts.dryRun ?? false,
    });
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers, body });
    } catch (e) {
      results.push({
        status: 'error',
        message: `network error: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    if (res.status === 404) {
      results.push({
        status: 'not_implemented',
        message:
          `${res.status} ${res.statusText} — admin import endpoint is not deployed yet (B-3 / KS-2018).`,
      });
      continue;
    }
    let parsed: unknown = null;
    const text = await res.text();
    try {
      parsed = text.length ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      results.push({
        status: 'error',
        message: `${res.status} ${res.statusText}`,
        raw: parsed,
      });
      continue;
    }
    results.push({ status: 'ok', raw: parsed });
  }
  return results;
}

export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : '/' + path;
  return b + p;
}
