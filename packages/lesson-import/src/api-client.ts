/**
 * KS-2017 / B-1 — тонкий клиент к admin API для чтения текущего
 * состояния курса/урока (для diff'а и export'а). Использует встроенный
 * `fetch` Node 20+.
 *
 * Эндпоинты (см. apps/api/src/lessons/admin/):
 *  - GET  /lessons/admin/courses             — список курсов
 *  - GET  /lessons/admin/courses/:id         — курс + lessons[] (без шагов)
 *  - GET  /lessons/admin/lessons/:id         — урок + steps[]
 */

import type { DbCourseSnapshot, DbLessonSnapshot, DbStepSnapshot } from './types.js';
import { joinUrl } from './upserter.js';

export interface AdminClientOptions {
  baseUrl: string;
  token?: string;
}

export class AdminApiClient {
  constructor(private readonly opts: AdminClientOptions) {}

  async getCourseBySlug(slug: string): Promise<DbCourseSnapshot | null> {
    const list = await this.req<Array<{ id: string; slug: string }>>(
      'GET',
      '/lessons/admin/courses',
    );
    const c = list.find((x) => x.slug === slug);
    if (!c) return null;
    const full = await this.req<{
      id: string;
      slug: string;
      lessons: Array<{ id: string; slug: string; order: number; [k: string]: unknown }>;
      [k: string]: unknown;
    }>('GET', `/lessons/admin/courses/${c.id}`);
    const lessons: DbLessonSnapshot[] = [];
    for (const l of full.lessons) {
      const lessonFull = await this.getLessonById(l.id);
      lessons.push(lessonFull);
    }
    // Сохраняем все мета-поля курса (titleKey, title, level, tags, ...)
    // — они нужны exporter'у. Уроки переписываем уже обогащённым списком.
    return { ...full, id: full.id, slug: full.slug, lessons };
  }

  async getLessonById(id: string): Promise<DbLessonSnapshot> {
    const data = await this.req<{
      id: string;
      slug: string;
      order: number;
      steps: Array<{ id: string; order: number; type: string; payload: Record<string, unknown> }>;
      [k: string]: unknown;
    }>('GET', `/lessons/admin/lessons/${id}`);
    const steps: DbStepSnapshot[] = data.steps
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ id: s.id, order: s.order, type: s.type, payload: s.payload }));
    return {
      ...data,
      id: data.id,
      slug: data.slug,
      order: data.order,
      steps,
    } as DbLessonSnapshot;
  }

  /** Грубый GET. Бросает на не-2xx с детализацией. */
  private async req<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    const res = await fetch(joinUrl(this.opts.baseUrl, path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${path} → ${res.status} ${res.statusText}: ${text}`);
    }
    if (text.length === 0) return null as unknown as T;
    return JSON.parse(text) as T;
  }
}
