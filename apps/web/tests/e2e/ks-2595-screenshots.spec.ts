import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * KS-2595: одноразовый spec для скрин-сверки до/после mobile-вёрстки
 * страницы редактирования урока. Гоняется руками для acceptance:
 *   `playwright test ks-2595-screenshots`
 *
 * Снимает 4 скриншота (mobile RU/EN + desktop RU/EN) после правок:
 *  - лейблы «Название урока» / «Lesson title» и «Расчётное время, мин.» /
 *    «Estimated minutes» — над инпутами на mobile, инпуты на полную
 *    ширину контейнера;
 *  - кнопка «Удалить урок» / «Delete lesson» с явным контекстом;
 *  - desktop вёрстка не сломана (flex-wrap row).
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const SCREENSHOTS_DIR = '/tmp/KS-2595';

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

async function createCourseWithLesson(
  tokens: AuthTokens,
  title: string,
): Promise<{ courseId: string; slug: string; lessonId: string }> {
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
    if (r.status !== 429) throw new Error(`create-course: ${r.status}`);
    await new Promise((res) => setTimeout(res, 2000 * 2 ** i));
  }
  if (!course) throw new Error('create-course failed');
  const lessonRes = await fetch(
    `${API_URL}/lessons/user-courses/${course.id}/lessons`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Новый урок' }),
    },
  );
  if (!lessonRes.ok) throw new Error(`create-lesson: ${lessonRes.status}`);
  const lesson = (await lessonRes.json()) as { id: string };
  return { courseId: course.id, slug: course.slug, lessonId: lesson.id };
}

async function seedAuth(
  page: Page,
  tokens: AuthTokens,
  locale: 'ru' | 'en',
): Promise<void> {
  await page.addInitScript(
    ([access, refresh, loc]) => {
      localStorage.setItem('token', access);
      localStorage.setItem('refreshToken', refresh);
      localStorage.setItem('locale', loc);
    },
    [tokens.accessToken, tokens.refreshToken, locale] as [
      string,
      string,
      string,
    ],
  );
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

for (const locale of ['ru', 'en'] as const) {
  test(`KS-2595 скриншот lesson-edit (${locale})`, async ({
    page,
  }, testInfo) => {
    const platform = testInfo.project.name === 'mobile' ? 'mobile' : 'desktop';
    const tokens = await devBypassLogin(
      `e2e-ks2595-${platform}-${locale}-${Date.now()}`,
    );
    const fixture = await createCourseWithLesson(
      tokens,
      `KS-2595 ${platform} ${locale} ${Date.now()}`,
    );
    await seedAuth(page, tokens, locale);
    await page.goto(
      `/lessons/my/${fixture.slug}/edit?lesson=${fixture.lessonId}`,
    );
    await expect(page.getByTestId('user-course-editor')).toBeVisible({
      timeout: 15_000,
    });
    if (platform === 'mobile') {
      await page.getByTestId('user-course-editor-tab-editor').click();
    }
    // Дожидаемся, что lesson-overview header полностью отрисован.
    await expect(
      page.getByTestId(`lesson-overview-title-${fixture.lessonId}`),
    ).toBeVisible({ timeout: 10_000 });
    // Estimated minutes — заполнить, чтобы был визуальный «before/after» smile.
    await page.getByTestId(`lesson-overview-est-${fixture.lessonId}`).fill('15');

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, `${platform}-${locale}.png`),
      fullPage: true,
    });

    await cleanupCourse(tokens, fixture.courseId);
  });
}
