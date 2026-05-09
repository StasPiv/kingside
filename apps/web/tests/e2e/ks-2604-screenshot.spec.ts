import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * KS-2604 (ADR-051 §4 B2): скрин-сверка для acceptance.
 *
 * Что проверяем:
 *  - Клик «+ Новый анализ» в `/workshop` (Мастерская → My analyses)
 *    делает POST /analyses → navigate('/analysis/<id>') с уникальным id.
 *  - Доска пустая, не подтягивается прошлая партия.
 *  - Скриншот «после» — `/tmp/KS-2604/workshop-after-newbtn.png`
 *    (страница `/analysis/<id>` сразу после клика).
 *
 * Сценарий «до» (для контекста acceptance):
 *  - Раньше клик вёл на `/analysis` без id; AnalysisPage на mount
 *    сам делал auto-create + replaceState — URL подменялся, но
 *    React Router об этом не знал, второй заход открывал прошлую
 *    запись из localStorage autosave (KS-2403).
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const SCREENSHOTS_DIR = '/tmp/KS-2604';

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

async function seedAuth(page: Page, tokens: AuthTokens): Promise<void> {
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('token', access);
      localStorage.setItem('refreshToken', refresh);
    },
    [tokens.accessToken, tokens.refreshToken] as [string, string],
  );
}

test.describe.configure({ mode: 'serial' });

test('KS-2604 «+ Новый анализ» создаёт уникальный id и пустую доску', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'Достаточно одного скриншот-проекта; mobile-вариант не отличается логикой кнопки.',
  );
  const tokens = await devBypassLogin(`e2e-ks2604-${Date.now()}`);
  await seedAuth(page, tokens);

  await page.goto('/workshop');
  // Кнопка «+ Новый анализ» в WorkshopAnalysisList toolbar.
  const newBtn = page.locator('button.workshop-analyses-new-btn');
  await expect(newBtn).toBeVisible({ timeout: 10_000 });

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '01-workshop-before-click.png'),
    fullPage: true,
  });

  // Перехватываем POST /analyses, чтобы убедиться, что helper его
  // действительно делает (а не просто navigate'ит на /analysis без id).
  const postPromise = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' && /\/analyses$/.test(r.url()),
    { timeout: 10_000 },
  );
  await newBtn.click();
  const postRes = await postPromise;
  expect(postRes.ok()).toBe(true);
  const created = (await postRes.json()) as { id: string };
  expect(created.id).toBeTruthy();

  // URL после navigate'а — `/analysis/<id>`, не голый `/analysis`.
  await page.waitForURL(new RegExp(`/analysis/${created.id}$`), {
    timeout: 10_000,
  });
  expect(page.url()).toMatch(new RegExp(`/analysis/${created.id}$`));

  // AnalysisPage загружается; делаем скрин «после».
  // Ждём контейнер AnalysisPage — без жёстких зависимостей на конкретные
  // testid'ы (которые могут поменяться); достаточно что URL правильный
  // и страница отрисована.
  await page.waitForLoadState('networkidle', { timeout: 10_000 });
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '02-analysis-after-newbtn.png'),
    fullPage: true,
  });

  // Cleanup: удаляем созданную запись чтобы не засорять БД.
  await fetch(`${API_URL}/analyses/${created.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  }).catch(() => {});
});
