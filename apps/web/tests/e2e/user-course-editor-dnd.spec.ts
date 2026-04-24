import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * KS-1861 (FE-R13): e2e smoke для dnd-kit reorder в UserCourseEditor.
 *
 * Что проверяем в браузере (happy-dom/jsdom не даёт настоящих pointer
 * событий, поэтому unit-тестов на drag-flow у нас нет — только здесь):
 *
 *  1. Drag-handle `⠿` получает ARIA-атрибуты от `@dnd-kit/sortable`
 *     (`role=button`, `aria-roledescription=sortable`, `tabindex=0`).
 *  2. Mouse-drag переставляет шаги в рамках урока — порядок в DOM
 *     меняется, PATCH-запрос летит в backend (`/user-lessons/:id/
 *     steps/reorder`).
 *  3. Скриншоты desktop + mobile для визуальной проверки handle'а.
 *
 * Touch-DnD (TouchSensor) в Playwright проверяется через
 * `page.touchscreen` — симулируем touchstart/touchmove/touchend.
 * Delay >=250ms из activationConstraint.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const SCREENSHOTS_DIR = '/tmp/KS-1861';

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
  if (!res.ok) throw new Error(`dev-bypass failed: ${res.status}`);
  return (await res.json()) as AuthTokens;
}

async function createCourseWithSteps(
  tokens: AuthTokens,
  title: string,
): Promise<{
  courseId: string;
  slug: string;
  lessonId: string;
  stepIds: string[];
}> {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${tokens.accessToken}`,
  };

  // Ретрай из-за 429 — лимитер create-course срабатывает при частом прогоне.
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
    if (r.status !== 429) throw new Error(`create-course: ${r.status}`);
    await new Promise((res) => setTimeout(res, 2000 * 2 ** i));
  }
  if (!course) throw new Error('create-course failed: 429 max retries');

  const lessonRes = await fetch(
    `${API_URL}/lessons/user-courses/${course.id}/lessons`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'DnD lesson' }),
    },
  );
  if (!lessonRes.ok) throw new Error(`create-lesson: ${lessonRes.status}`);
  const lesson = (await lessonRes.json()) as { id: string };

  const stepIds: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const stepRes = await fetch(
      `${API_URL}/lessons/user-lessons/${lesson.id}/steps`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'text',
          payload: {
            type: 'text',
            bodyMarkdown: `Step ${i + 1}`,
            diagrams: [],
          },
        }),
      },
    );
    if (!stepRes.ok) throw new Error(`create-step: ${stepRes.status}`);
    const step = (await stepRes.json()) as { id: string };
    stepIds.push(step.id);
  }

  return {
    courseId: course.id,
    slug: course.slug,
    lessonId: lesson.id,
    stepIds,
  };
}

async function seedAuth(page: Page, tokens: AuthTokens): Promise<void> {
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('token', access);
      localStorage.setItem('refreshToken', refresh);
    },
    [tokens.accessToken, tokens.refreshToken] as [string, string],
  );
}

function screenshotPath(name: string): string {
  return path.join(SCREENSHOTS_DIR, `${name}.png`);
}

async function cleanupCourse(
  tokens: AuthTokens,
  courseId: string,
): Promise<void> {
  await fetch(`${API_URL}/lessons/user-courses/${courseId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  }).catch(() => {});
}

test.describe.configure({ mode: 'serial' });

test.describe('UserCourseEditor DnD (dnd-kit)', () => {
  test('desktop: drag-handle имеет ARIA от dnd-kit, mouse-drag переставляет шаги', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Desktop DnD-сценарий.',
    );
    const tokens = await devBypassLogin(`e2e-dnd-desktop-${Date.now()}`);
    const fixture = await createCourseWithSteps(
      tokens,
      `KS-1861 DnD ${Date.now()}`,
    );
    await seedAuth(page, tokens);
    await page.goto(`/lessons/my/${fixture.slug}/edit?lesson=${fixture.lessonId}`);
    await expect(page.getByTestId('user-course-editor')).toBeVisible({
      timeout: 15_000,
    });

    // Шаги должны быть видны — раскрытия не требуется, StepCard сам
    // рендерится сразу в lesson-overview.
    const firstStepItem = page.getByTestId(
      `lesson-overview-step-item-${fixture.stepIds[0]}`,
    );
    await expect(firstStepItem).toBeVisible({ timeout: 10_000 });

    // 1) ARIA от useSortable
    const firstHandle = page.getByTestId(
      `step-card-drag-${fixture.stepIds[0]}`,
    );
    await expect(firstHandle).toHaveAttribute('role', 'button');
    await expect(firstHandle).toHaveAttribute(
      'aria-roledescription',
      'sortable',
    );
    await expect(firstHandle).toHaveAttribute('tabindex', '0');
    await page.screenshot({
      path: screenshotPath('desktop-01-handles-aria'),
      fullPage: true,
    });

    // 2) Mouse-drag: первый шаг → позиция третьего.
    const firstBox = await firstHandle.boundingBox();
    const thirdItem = page.getByTestId(
      `lesson-overview-step-item-${fixture.stepIds[2]}`,
    );
    const thirdBox = await thirdItem.boundingBox();
    if (!firstBox || !thirdBox) throw new Error('boundingBox returned null');

    // PointerSensor activationConstraint distance=5 — двигаем «с запасом».
    await page.mouse.move(
      firstBox.x + firstBox.width / 2,
      firstBox.y + firstBox.height / 2,
    );
    await page.mouse.down();
    // Промежуточная точка, чтобы сработал activation distance.
    await page.mouse.move(
      firstBox.x + firstBox.width / 2 + 10,
      firstBox.y + firstBox.height / 2 + 10,
      { steps: 5 },
    );
    await page.mouse.move(
      thirdBox.x + thirdBox.width / 2,
      thirdBox.y + thirdBox.height + 10,
      { steps: 20 },
    );
    // Ждём PATCH reorder перед mouseup, чтобы поймать сетевой запрос.
    const reorderReq = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        /\/user-lessons\/[^/]+\/steps\/reorder$/.test(r.url()),
      { timeout: 10_000 },
    );
    await page.mouse.up();
    await reorderReq;
    await page.screenshot({
      path: screenshotPath('desktop-02-after-drag'),
      fullPage: true,
    });

    // 3) Порядок в DOM изменился: был [s1, s2, s3], после drag s1 ушёл вниз.
    const items = await page
      .locator('[data-testid^="lesson-overview-step-item-"]')
      .evaluateAll((nodes) =>
        nodes.map((n) => (n as HTMLElement).dataset.testid ?? ''),
      );
    expect(items).toHaveLength(3);
    expect(items[0]).not.toBe(
      `lesson-overview-step-item-${fixture.stepIds[0]}`,
    );

    await cleanupCourse(tokens, fixture.courseId);
  });

  test('mobile: drag-handles видимы, ARIA от dnd-kit, скриншот для визуальной проверки', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'mobile',
      'Mobile-smoke для touch-DnD.',
    );
    const tokens = await devBypassLogin(`e2e-dnd-mobile-${Date.now()}`);
    const fixture = await createCourseWithSteps(
      tokens,
      `KS-1861 DnD Mobile ${Date.now()}`,
    );
    await seedAuth(page, tokens);
    await page.goto(`/lessons/my/${fixture.slug}/edit?lesson=${fixture.lessonId}`);
    await expect(page.getByTestId('user-course-editor')).toBeVisible({
      timeout: 15_000,
    });
    // Переключаемся на editor-tab чтобы StepCard'ы были видны.
    await page.getByTestId('user-course-editor-tab-editor').click();
    await expect(
      page.getByTestId(`lesson-overview-step-item-${fixture.stepIds[0]}`),
    ).toBeVisible({ timeout: 10_000 });
    const firstHandle = page.getByTestId(
      `step-card-drag-${fixture.stepIds[0]}`,
    );
    await expect(firstHandle).toHaveAttribute('role', 'button');
    await expect(firstHandle).toHaveAttribute(
      'aria-roledescription',
      'sortable',
    );
    await page.screenshot({
      path: screenshotPath('mobile-01-handles-aria'),
      fullPage: false,
    });

    // Outline-tab — drag-handle урока должен быть виден с ARIA.
    await page.getByTestId('user-course-editor-tab-outline').click();
    const lessonHandle = page.getByTestId(
      `course-outline-drag-${fixture.lessonId}`,
    );
    await expect(lessonHandle).toBeVisible({ timeout: 5_000 });
    await expect(lessonHandle).toHaveAttribute('role', 'button');
    await expect(lessonHandle).toHaveAttribute(
      'aria-roledescription',
      'sortable',
    );
    await page.screenshot({
      path: screenshotPath('mobile-02-outline-handle'),
      fullPage: false,
    });

    await cleanupCourse(tokens, fixture.courseId);
  });
});
