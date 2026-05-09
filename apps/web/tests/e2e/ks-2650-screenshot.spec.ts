import { test, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2650 — desktop+mobile скриншоты табов «Все / Мои» на /lessons.
 *
 * Сценарий:
 *  1. Login через dev-bypass.
 *  2. Открыть /lessons — табы видны (для логина), Sidebar без 🎒.
 *  3. Скриншот desktop таб «Все».
 *  4. Кликнуть «Мои» — URL `?tab=mine`, виден MyCoursesView.
 *  5. Скриншот desktop таб «Мои».
 *  6. Mobile (Pixel 5) — те же два кадра.
 *  7. Открыть /lessons/my — редирект на /lessons?tab=mine.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2650';

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

test.describe.configure({ mode: 'serial' });

test('KS-2650: /lessons табы All/My + редирект /lessons/my', async ({
  page,
}, testInfo) => {
  const tokens = await devBypass(`ks2650-${Date.now()}`);
  await seedAuth(page, tokens);
  const proj = testInfo.project.name;

  // 1. /lessons → таб All активен по умолчанию.
  await page.goto('/lessons');
  await page.getByTestId('lessons-page').waitFor({ timeout: 15_000 });
  await page.getByTestId('lessons-tab-all').waitFor();
  await page.getByTestId('lessons-tab-mine').waitFor();
  await page.screenshot({
    path: `${DIR}/${proj}-tab-all.png`,
    fullPage: true,
  });

  // 2. Клик «Мои» → URL ?tab=mine + виден my-courses-page.
  await page.getByTestId('lessons-tab-mine').click();
  await page.waitForURL(/\?tab=mine$/, { timeout: 5_000 });
  await page.getByTestId('my-courses-page').waitFor({ timeout: 15_000 });
  await page.screenshot({
    path: `${DIR}/${proj}-tab-mine.png`,
    fullPage: true,
  });

  // 3. /lessons/my → редирект на /lessons?tab=mine.
  await page.goto('/lessons/my');
  await page.waitForURL(/\/lessons\?tab=mine$/, { timeout: 5_000 });
  await page.getByTestId('my-courses-page').waitFor({ timeout: 15_000 });

  // 4. Sidebar — пункт «🎒» удалён, виден только «🎓».
  await page.goto('/lessons');
  await page.getByTestId('lessons-page').waitFor({ timeout: 15_000 });
  // На mobile sidebar коллапсирован, проверяем только desktop-проект.
  if (proj === 'desktop') {
    const lessonLinks = await page
      .locator('aside.sidebar a[href="/lessons"]')
      .count();
    if (lessonLinks !== 1) throw new Error(`expected 1 sidebar /lessons link, got ${lessonLinks}`);
    const myLinks = await page
      .locator('aside.sidebar a[href="/lessons/my"]')
      .count();
    if (myLinks !== 0) throw new Error(`expected 0 sidebar /lessons/my links, got ${myLinks}`);
  }
});
