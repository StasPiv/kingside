import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2645 / KS-2636 (ADR-054 Phase D) — e2e унифицированного reader'a.
 *
 * Phase D объединил `UserCoursePage`/`UserLessonPage` с `CoursePage`/
 * `LessonPage`. Один маршрут `/lessons/:slug[/:lessonId]` теперь
 * рендерит оба типа курсов: системные (с titleI18nKey, blocks, hero,
 * SM-2) и пользовательские (с Public/Private бейджем, plain title,
 * step-pagination). Различение по `course.ownerId`.
 *
 * Тесты покрывают:
 *  1. Старый маршрут `/lessons/my/:slug` редиректит на
 *     `/lessons/:slug` и отдаёт user-UI (`data-testid=user-course-page`).
 *  2. Старый `/lessons/my/:slug/:lessonId` редиректит на
 *     `/lessons/:slug/:lessonId` и отдаёт user-lesson UI
 *     (`data-testid=user-lesson-page`) с активным шагом по `?step=1`.
 *  3. Полный mini-цикл прохождения user-урока на унифицированном
 *     reader'е: создать курс/урок/шаг через REST → открыть на
 *     унифицированном маршруте → пометить шаг done → нажать Complete →
 *     navigate обратно на курс.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const SCREENSHOTS_DIR = '/tmp/KS-2645';

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

async function devBypass(username: string): Promise<Tokens> {
  const res = await fetch(`${API_URL}/auth/dev-bypass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: DEV_BYPASS_SECRET, user: username }),
  });
  if (!res.ok) throw new Error(`dev-bypass ${res.status}`);
  return (await res.json()) as Tokens;
}

async function api<T>(
  tokens: Tokens,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

async function seedAuth(page: Page, tokens: Tokens): Promise<void> {
  await page.addInitScript(
    ([a, r]) => {
      localStorage.setItem('token', a);
      localStorage.setItem('refreshToken', r);
      localStorage.setItem('locale', 'en');
    },
    [tokens.accessToken, tokens.refreshToken] as [string, string],
  );
}

async function seedCourseWithLessonAndStep(
  tokens: Tokens,
  title: string,
): Promise<{ courseId: string; slug: string; lessonId: string; stepId: string }> {
  const course = await api<{ id: string; slug: string }>(
    tokens,
    'POST',
    '/lessons/courses',
    { title },
  );
  const lesson = await api<{ id: string }>(
    tokens,
    'POST',
    `/lessons/courses/${course.id}/lessons`,
    { title: 'Lesson 1' },
  );
  const step = await api<{ id: string }>(
    tokens,
    'POST',
    `/lessons/lessons/${lesson.id}/steps`,
    {
      type: 'text',
      payload: {
        type: 'text',
        bodyMarkdown: '# Unified reader\n\nThis is a **single** step.',
        diagrams: [],
      },
    },
  );
  return {
    courseId: course.id,
    slug: course.slug,
    lessonId: lesson.id,
    stepId: step.id,
  };
}

async function cleanup(tokens: Tokens, courseId: string): Promise<void> {
  await fetch(`${API_URL}/lessons/courses/${courseId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  }).catch(() => {});
}

test.describe.configure({ mode: 'serial' });

test('KS-2645/KS-2636: /lessons/my/:slug → редирект на /lessons/:slug, виден UserCourseView', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'Достаточно проверить редирект и UI на одном проекте.',
  );
  const tokens = await devBypass(`unified-course-${Date.now()}`);
  const fixture = await seedCourseWithLessonAndStep(
    tokens,
    `KS-2645 unified course ${Date.now()}`,
  );
  await seedAuth(page, tokens);

  // 1. Открываем legacy URL `/lessons/my/<slug>`.
  await page.goto(`/lessons/my/${fixture.slug}`);

  // 2. Browser должен оказаться на унифицированном маршруте.
  await page.waitForURL(new RegExp(`/lessons/${fixture.slug}$`), {
    timeout: 10_000,
  });

  // 3. Виден user-course UI (data-testid сохранён из старой страницы).
  await expect(page.getByTestId('user-course-page')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('user-course-title')).toContainText(
    'KS-2645 unified course',
  );
  // Public/Private бейдж виден.
  await expect(
    page.getByTestId('user-course-private-badge'),
  ).toBeVisible();

  await page.screenshot({
    path: `${SCREENSHOTS_DIR}/desktop-unified-course.png`,
    fullPage: true,
  });

  await cleanup(tokens, fixture.courseId);
});

test('KS-2645/KS-2636: /lessons/my/:slug/:lessonId → редирект на /lessons/:slug/:lessonId, активный шаг 1', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'Достаточно проверить редирект и UI на одном проекте.',
  );
  const tokens = await devBypass(`unified-lesson-${Date.now()}`);
  const fixture = await seedCourseWithLessonAndStep(
    tokens,
    `KS-2645 unified lesson ${Date.now()}`,
  );
  await seedAuth(page, tokens);

  // 1. Открываем legacy lesson URL.
  await page.goto(`/lessons/my/${fixture.slug}/${fixture.lessonId}`);

  // 2. Редирект на унифицированный + дефолтный `?step=1`.
  await page.waitForURL(
    new RegExp(`/lessons/${fixture.slug}/${fixture.lessonId}\\?step=1$`),
    { timeout: 10_000 },
  );

  // 3. Виден user-lesson UI с активным шагом.
  await expect(page.getByTestId('user-lesson-page')).toBeVisible({
    timeout: 15_000,
  });
  // Прогресс-индикатор «Step 1/1 …».
  await expect(page.getByTestId('user-lesson-progress')).toContainText(
    /Step 1\/1/,
  );
  // Один активный <li> внутри step-list.
  const stepList = page.getByTestId('user-lesson-step-list');
  await expect(stepList).toBeVisible();
  await expect(stepList.locator('> li')).toHaveCount(1);

  await page.screenshot({
    path: `${SCREENSHOTS_DIR}/desktop-unified-lesson.png`,
    fullPage: true,
  });

  await cleanup(tokens, fixture.courseId);
});

test('KS-2645/KS-2636: полный цикл прохождения на унифицированном маршруте — TextStep → done → Complete', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'Полный цикл — на desktop. Mobile-проверки в KS-2634.',
  );
  const tokens = await devBypass(`unified-flow-${Date.now()}`);
  const fixture = await seedCourseWithLessonAndStep(
    tokens,
    `KS-2645 unified flow ${Date.now()}`,
  );
  await seedAuth(page, tokens);

  // Открываем напрямую унифицированный маршрут (без legacy `/my`).
  await page.goto(`/lessons/${fixture.slug}/${fixture.lessonId}`);
  await expect(page.getByTestId('user-lesson-page')).toBeVisible({
    timeout: 15_000,
  });

  // Кнопка Complete сейчас неактивна (порог 70%, шаг pending).
  const complete = page.getByTestId('user-lesson-complete-btn');
  await expect(complete).toBeDisabled();

  // Помечаем шаг done через клик по «Got it» внутри TextStep.
  await page.getByTestId('lesson-text-step-next').click();

  // POST `/lessons/progress/lessons/<id>/step` улетит — ждём debounce.
  // markStep дебаунс 400ms.
  await page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new RegExp(
        `/lessons/progress/lessons/${fixture.lessonId}/step$`,
      ).test(r.url()),
    { timeout: 5_000 },
  );

  // Complete теперь активна (1/1 = 100% ≥ 70%).
  await expect(complete).toBeEnabled();

  // Жмём Complete — ждём POST complete и редирект на курс.
  const [completeRes] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new RegExp(
          `/lessons/progress/lessons/${fixture.lessonId}/complete$`,
        ).test(r.url()),
      { timeout: 5_000 },
    ),
    complete.click(),
  ]);
  expect(completeRes.ok(), `complete: ${completeRes.status()}`).toBe(true);

  // После Complete UserLessonView делает navigate на курс.
  await page.waitForURL(new RegExp(`/lessons/${fixture.slug}$`), {
    timeout: 10_000,
  });
  await expect(page.getByTestId('user-course-page')).toBeVisible({
    timeout: 15_000,
  });

  await cleanup(tokens, fixture.courseId);
});
