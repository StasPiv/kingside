import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { userCoursesApi } from './userCoursesApi';

/**
 * KS-1835 (FE-1): контрактные тесты API-клиента пользовательских курсов.
 *
 * Мокаем `globalThis.fetch` (через который работает общий `request` из
 * `../api`) и проверяем, что каждая обёртка собирает правильный URL +
 * HTTP-метод + тело. Типы уже проверены на шаге компиляции —
 * `CreateUserCourseRequest` и т.д. приходят из `@kingside/shared`.
 *
 * Базовый `VITE_API_URL` в vitest (`.env` через vite) по умолчанию
 * `http://localhost:3001` (fallback в `api.ts`).
 */

const mockFetch = vi.fn();
const API = 'http://localhost:3001';
const BASE = `${API}/api/lessons`;

function okJson<T>(payload: T, status = 200) {
  return {
    ok: true,
    status,
    json: () => Promise.resolve(payload),
  };
}

function okEmpty() {
  return { ok: true, status: 204 };
}

function lastCallArgs() {
  const calls = mockFetch.mock.calls;
  return calls[calls.length - 1];
}

beforeEach(() => {
  localStorage.clear();
  mockFetch.mockReset();
  // Install local mock on top of test-setup globals so our expectations
  // hit this file's jest-mock instance (see `api.test.ts` для паттерна).
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('userCoursesApi — courses', () => {
  it('list() без параметров → GET /user-courses', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ data: [] }));
    await userCoursesApi.list();
    const [url, init] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-courses`);
    expect(init.method).toBeUndefined(); // GET — default
  });

  it('list({ scope: "public" }) → GET /user-courses?scope=public', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ data: [] }));
    await userCoursesApi.list({ scope: 'public' });
    const [url] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-courses?scope=public`);
  });

  it('list({ scope: "own" }) → GET /user-courses?scope=own', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ data: [] }));
    await userCoursesApi.list({ scope: 'own' });
    const [url] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-courses?scope=own`);
  });

  it('getBySlug() → GET /user-courses/:slug с URL-escape', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ course: {}, lessons: [], progress: null }));
    await userCoursesApi.getBySlug('my course/1');
    const [url] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-courses/my%20course%2F1`);
  });

  it('create() → POST /user-courses с телом', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ id: 'c1' }));
    await userCoursesApi.create({ title: 'My course', description: 'test' });
    const [url, init] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-courses`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ title: 'My course', description: 'test' });
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('update() → PATCH /user-courses/:id', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ id: 'c1' }));
    await userCoursesApi.update('c1', { isPublic: true });
    const [url, init] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-courses/c1`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ isPublic: true });
  });

  it('delete() → DELETE /user-courses/:id, 204 → undefined', async () => {
    mockFetch.mockResolvedValueOnce(okEmpty());
    const res = await userCoursesApi.delete('c1');
    const [url, init] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-courses/c1`);
    expect(init.method).toBe('DELETE');
    expect(res).toBeUndefined();
  });
});

describe('userCoursesApi — lessons', () => {
  it('createLesson() → POST /user-courses/:id/lessons', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ id: 'l1' }));
    await userCoursesApi.createLesson('c1', { title: 'L1', estMinutes: 10 });
    const [url, init] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-courses/c1/lessons`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ title: 'L1', estMinutes: 10 });
  });

  it('getLesson() → GET /user-lessons/:id', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ lesson: {}, steps: [], progress: null }));
    await userCoursesApi.getLesson('l1');
    const [url] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-lessons/l1`);
  });

  it('updateLesson() → PATCH /user-lessons/:id', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ id: 'l1' }));
    await userCoursesApi.updateLesson('l1', { order: 3 });
    const [url, init] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-lessons/l1`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ order: 3 });
  });

  it('deleteLesson() → DELETE /user-lessons/:id', async () => {
    mockFetch.mockResolvedValueOnce(okEmpty());
    await userCoursesApi.deleteLesson('l1');
    const [url, init] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-lessons/l1`);
    expect(init.method).toBe('DELETE');
  });
});

describe('userCoursesApi — steps', () => {
  it('createStep() → POST /user-lessons/:id/steps', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ id: 's1' }));
    await userCoursesApi.createStep('l1', {
      type: 'text',
      payload: { type: 'text', bodyMarkdown: 'hi', diagrams: [] },
    });
    const [url, init] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-lessons/l1/steps`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      type: 'text',
      payload: { type: 'text', bodyMarkdown: 'hi', diagrams: [] },
    });
  });

  it('updateStep() → PATCH /user-lesson-steps/:id', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ id: 's1' }));
    await userCoursesApi.updateStep('s1', { order: 2 });
    const [url, init] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-lesson-steps/s1`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ order: 2 });
  });

  it('deleteStep() → DELETE /user-lesson-steps/:id', async () => {
    mockFetch.mockResolvedValueOnce(okEmpty());
    await userCoursesApi.deleteStep('s1');
    const [url, init] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-lesson-steps/s1`);
    expect(init.method).toBe('DELETE');
  });

  it('reorderSteps() → POST /user-lessons/:id/steps/reorder', async () => {
    mockFetch.mockResolvedValueOnce(okEmpty());
    await userCoursesApi.reorderSteps('l1', { ids: ['s2', 's1', 's3'] });
    const [url, init] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-lessons/l1/steps/reorder`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ ids: ['s2', 's1', 's3'] });
  });
});

describe('userCoursesApi — progress (BE-4)', () => {
  it('updateStepProgress() → POST /user-progress/lessons/:id/step', async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({
        userLessonId: 'l1',
        completedStepsCount: 1,
        totalSteps: 3,
        startedAt: '2026-04-24T00:00:00Z',
        lastActivityAt: '2026-04-24T00:00:00Z',
        completedAt: null,
      }),
    );
    await userCoursesApi.updateStepProgress('l1', {
      stepId: 's1',
      state: 'done',
    });
    const [url, init] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-progress/lessons/l1/step`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ stepId: 's1', state: 'done' });
  });

  it('completeLesson() → POST /user-progress/lessons/:id/complete', async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({
        userCourseId: 'c1',
        completedLessonsCount: 1,
        startedAt: '2026-04-24T00:00:00Z',
        lastActivityAt: '2026-04-24T00:00:00Z',
        completedAt: null,
      }),
    );
    await userCoursesApi.completeLesson('l1', { score: 0.85 });
    const [url, init] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-progress/lessons/l1/complete`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ score: 0.85 });
  });

  it('getCourseProgress() → GET /user-progress/courses/:id', async () => {
    mockFetch.mockResolvedValueOnce(okJson(null));
    await userCoursesApi.getCourseProgress('c1');
    const [url] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-progress/courses/c1`);
  });

  it('getLessonProgress() → GET /user-progress/lessons/:id', async () => {
    mockFetch.mockResolvedValueOnce(okJson(null));
    await userCoursesApi.getLessonProgress('l1');
    const [url] = lastCallArgs();
    expect(url).toBe(`${BASE}/user-progress/lessons/l1`);
  });
});

describe('userCoursesApi — общее (auth / error)', () => {
  it('JWT из localStorage пробрасывается в Authorization: Bearer', async () => {
    localStorage.setItem('token', 'jwt-abc');
    mockFetch.mockResolvedValueOnce(okJson({ data: [] }));
    await userCoursesApi.list();
    const [, init] = lastCallArgs();
    expect(init.headers.Authorization).toBe('Bearer jwt-abc');
  });

  it('без токена — Authorization не ставится', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ data: [] }));
    await userCoursesApi.list();
    const [, init] = lastCallArgs();
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('4xx с message → ApiError пробрасывается вверх', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ message: 'Invalid slug' }),
    });
    await expect(userCoursesApi.getBySlug('bad')).rejects.toThrow('Invalid slug');
  });
});
