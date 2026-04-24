import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * KS-1872 (regression): меню `[⋯]` в `StepCard` должно открываться
 * на desktop по mouse-click и быть фактически видно пользователю.
 *
 * Природа исходного бага: после KS-1861 (`@dnd-kit/sortable`) меню
 * рендерилось в DOM (computed-style говорил `visible`), но
 * `.step-card { overflow: hidden }` обрезал popover, который был
 * позиционирован под header'ом. Пользователь видел только тень
 * внизу карточки. Фикс — рендер меню в `createPortal(document.body)`
 * с `position: fixed`.
 *
 * Проверяем три инварианта:
 *  1. После click trigger меню есть в DOM.
 *  2. Parent меню — `<body>` (не StepCard) — это и означает портал.
 *  3. BoundingBox меню целиком внутри viewport (не клиппится).
 *  4. Click outside закрывает меню.
 *  5. Chevron всё ещё toggle'ит `data-expanded` (не сломали).
 *  6. Скриншоты до/после клика для визуальной проверки.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const SCREENSHOTS_DIR = '/tmp/KS-1872';

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

async function devBypassLogin(username: string): Promise<AuthTokens> {
  const res = await fetch(`${API_URL}/auth/dev-bypass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: DEV_BYPASS_SECRET, user: username }),
  });
  if (!res.ok) throw new Error(`dev-bypass: ${res.status}`);
  return (await res.json()) as AuthTokens;
}

async function createCourseWithStep(
  tokens: AuthTokens,
  title: string,
): Promise<{
  courseId: string;
  slug: string;
  lessonId: string;
  stepId: string;
}> {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${tokens.accessToken}`,
  };
  let course: { id: string; slug: string } | null = null;
  for (let i = 0; i < 6; i += 1) {
    const r = await fetch(`${API_URL}/lessons/user-courses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title }),
    });
    if (r.ok) {
      course = (await r.json()) as { id: string; slug: string };
      break;
    }
    await new Promise((res) => setTimeout(res, 2000 * 2 ** i));
  }
  if (!course) throw new Error('create-course failed');
  const lesson = (await (
    await fetch(`${API_URL}/lessons/user-courses/${course.id}/lessons`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'lesson' }),
    })
  ).json()) as { id: string };
  const step = (await (
    await fetch(`${API_URL}/lessons/user-lessons/${lesson.id}/steps`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'text',
        payload: { type: 'text', bodyMarkdown: 'body', diagrams: [] },
      }),
    })
  ).json()) as { id: string };
  return {
    courseId: course.id,
    slug: course.slug,
    lessonId: lesson.id,
    stepId: step.id,
  };
}

async function seedAuth(page: Page, tokens: AuthTokens): Promise<void> {
  await page.addInitScript(
    ([a, r]) => {
      localStorage.setItem('token', a);
      localStorage.setItem('refreshToken', r);
    },
    [tokens.accessToken, tokens.refreshToken] as [string, string],
  );
}

function screenshotPath(name: string): string {
  return path.join(SCREENSHOTS_DIR, `${name}.png`);
}

test('desktop: click [⋯] открывает портальное меню в видимой области viewport', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop-only.');
  const tokens = await devBypassLogin(`ks1872-desktop-${Date.now()}`);
  const fx = await createCourseWithStep(tokens, `KS-1872 ${Date.now()}`);
  await seedAuth(page, tokens);
  await page.goto(`/lessons/my/${fx.slug}/edit?lesson=${fx.lessonId}`);
  await expect(page.getByTestId('user-course-editor')).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByTestId(`lesson-overview-step-item-${fx.stepId}`),
  ).toBeVisible({ timeout: 10_000 });

  await page.screenshot({
    path: screenshotPath('desktop-01-before-click'),
    fullPage: true,
  });

  // 1) Click trigger
  const trigger = page.getByTestId(`step-card-menu-trigger-${fx.stepId}`);
  await trigger.click();

  const menu = page.getByTestId(`step-card-menu-${fx.stepId}`);
  await expect(menu).toBeVisible({ timeout: 2_000 });

  // 2) Меню вынесено в портал — parent должен быть `<body>`.
  const parentTag = await menu.evaluate(
    (el) => el.parentElement?.tagName ?? null,
  );
  expect(parentTag).toBe('BODY');

  // 3) BoundingBox целиком внутри viewport — не клиппится `overflow:hidden`
  //    у `.step-card`.
  const vp = page.viewportSize();
  if (!vp) throw new Error('no viewport');
  const box = await menu.boundingBox();
  if (!box) throw new Error('no menu bbox');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);

  // 4) Меню-айтемы кликабельны: hover effect, click duplicate ниже не
  //    тестируем (дубликация — отдельный flow), важна именно видимость.
  await expect(
    page.getByTestId(`step-card-menu-duplicate-${fx.stepId}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`step-card-menu-delete-${fx.stepId}`),
  ).toBeVisible();

  await page.screenshot({
    path: screenshotPath('desktop-02-menu-open'),
    fullPage: true,
  });

  // 5) Click outside — меню закрывается.
  await page.mouse.click(200, 500);
  await expect(menu).toHaveCount(0, { timeout: 1_000 });

  // 6) Chevron toggle'ит data-expanded.
  const card = page.getByTestId(`step-card-${fx.stepId}`);
  const before = await card.getAttribute('data-expanded');
  await page.getByTestId(`step-card-chevron-${fx.stepId}`).click();
  await page.waitForTimeout(150);
  const after = await card.getAttribute('data-expanded');
  expect(after).not.toBe(before);

  // Cleanup
  await fetch(`${API_URL}/lessons/user-courses/${fx.courseId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  }).catch(() => {});
});
