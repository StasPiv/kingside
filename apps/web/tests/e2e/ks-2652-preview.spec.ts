import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2652 — preview-режим автора курса («Посмотреть как студент»).
 *
 * Сценарий desktop+mobile:
 *  1. Login → создать курс с одним уроком и шагом, опубликовать.
 *  2. Открыть `/lessons/<slug>` — виден owner-блок: кнопки Edit /
 *     Make private / Delete + новая «Preview as student».
 *  3. Скриншот «owner mode».
 *  4. Клик «Preview as student» → URL `?preview=1`, owner-actions
 *     скрыты, виден preview-banner с кнопкой «Exit preview».
 *  5. Скриншот «preview mode».
 *  6. Открыть урок — URL содержит `?preview=1`, breadcrumb «Back to
 *     course» ведёт на `/lessons/<slug>?preview=1` (preview-флаг
 *     сохранён).
 *  7. Клик «Exit preview» → возврат к owner-mode.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2652';

fs.mkdirSync(DIR, { recursive: true });

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

async function seedFixture(
  tokens: Tokens,
  title: string,
): Promise<{ id: string; slug: string; lessonId: string }> {
  const course = await api<{ id: string; slug: string }>(
    tokens,
    'POST',
    '/lessons/courses',
    { title },
  );
  await api(tokens, 'PATCH', `/lessons/courses/${course.id}`, {
    isPublic: true,
  });
  const lesson = await api<{ id: string }>(
    tokens,
    'POST',
    `/lessons/courses/${course.id}/lessons`,
    { title: 'L1' },
  );
  await api(tokens, 'POST', `/lessons/lessons/${lesson.id}/steps`, {
    type: 'text',
    payload: {
      type: 'text',
      bodyMarkdown: '# Preview demo\n\nHello, **student**.',
      diagrams: [],
    },
  });
  return { id: course.id, slug: course.slug, lessonId: lesson.id };
}

test.describe.configure({ mode: 'serial' });

test('KS-2652: preview-режим автора курса (toggle, lesson, exit)', async ({
  page,
}, testInfo) => {
  const proj = testInfo.project.name;
  const tokens = await devBypass(`ks2652-${proj}-${Date.now()}`);
  const fixture = await seedFixture(
    tokens,
    `KS-2652 preview ${proj} ${Date.now()}`,
  );
  await seedAuth(page, tokens);

  // 1. Открываем курс — owner-mode.
  await page.goto(`/lessons/${fixture.slug}`);
  await expect(page.getByTestId('course-page')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('user-course-edit')).toBeVisible();
  await expect(
    page.getByTestId('user-course-toggle-visibility'),
  ).toBeVisible();
  await expect(page.getByTestId('user-course-delete')).toBeVisible();
  // KS-2652: новая кнопка enter-preview.
  await expect(
    page.getByTestId('user-course-preview-enter'),
  ).toBeVisible();
  await expect(page.getByTestId('user-course-stats')).toBeVisible();
  await page.screenshot({
    path: `${DIR}/${proj}-owner-mode.png`,
    fullPage: true,
  });

  // 2. Жмём «Preview as student» → URL ?preview=1, owner-actions
  // и stats скрыты, виден preview-bar.
  await page.getByTestId('user-course-preview-enter').click();
  await page.waitForURL(/\?preview=1$/, { timeout: 5_000 });
  await expect(page.getByTestId('user-course-preview-bar')).toBeVisible();
  await expect(
    page.getByTestId('user-course-owner-actions'),
  ).toBeHidden();
  await expect(page.getByTestId('user-course-stats')).toBeHidden();
  await page.screenshot({
    path: `${DIR}/${proj}-preview-mode.png`,
    fullPage: true,
  });

  // 3. Клик по уроку — preview флаг проброшен.
  // KS-2653: после унификации lesson-link имеет общий testid
  // `lesson-link-<slug>`, где slug для user = lesson.id (UUID).
  await page.getByTestId(`lesson-link-${fixture.lessonId}`).click();
  await page.waitForURL(
    new RegExp(
      `/lessons/${fixture.slug}/${fixture.lessonId}\\?(?=.*preview=1)(?=.*step=1)`,
    ),
    { timeout: 10_000 },
  );
  await expect(page.getByTestId('user-lesson-page')).toBeVisible({
    timeout: 15_000,
  });

  // 4. Возврат на курс через breadcrumb сохраняет preview-флаг.
  // Текст breadcrumb в EN — `All courses` (i18n key `lessons.backToList`).
  // Берём ВТОРОЙ <a> в breadcrumb (первый ведёт на /lessons).
  await page
    .locator('nav.user-lesson-page__breadcrumbs a')
    .nth(1)
    .click();
  await page.waitForURL(
    new RegExp(`/lessons/${fixture.slug}\\?preview=1$`),
    { timeout: 5_000 },
  );
  await expect(page.getByTestId('user-course-preview-bar')).toBeVisible();

  // 5. Exit preview → возврат к owner-mode.
  await page.getByTestId('user-course-preview-exit').click();
  await page.waitForURL(new RegExp(`/lessons/${fixture.slug}$`), {
    timeout: 5_000,
  });
  await expect(page.getByTestId('user-course-edit')).toBeVisible();
  await expect(
    page.getByTestId('user-course-preview-bar'),
  ).toBeHidden();

  // Cleanup.
  await fetch(`${API_URL}/lessons/courses/${fixture.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  }).catch(() => {});
});
