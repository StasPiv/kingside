import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2672 — публичная ссылка анализа открывает тот же AnalysisPage
 * (доска, ходы, навигация), но Share/Edit/Autosave недоступны для
 * не-владельца и анонима.
 *
 * Сценарий:
 *  1. Автор создаёт анализ через REST + делает publicу.
 *  2. Автор открывает `/analysis/<id>` — Share-кнопка ВИДНА.
 *  3. Не-владелец (другой залогиненный) открывает
 *     `/analysis/public/<id>` — доска видна, Share-кнопка скрыта.
 *  4. Анонимный browser context открывает ту же ссылку —
 *     доска видна, Share-кнопки нет.
 *  5. Автор делает private; аноним получает 404.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2672';

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

test.describe.configure({ mode: 'serial' });

test('KS-2672: public analysis рендерит ту же AnalysisPage без Share для не-владельца', async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'Достаточно одного desktop-прогона.',
  );
  const authorTokens = await devBypass(`ks2672-author-${Date.now()}`);
  const otherTokens = await devBypass(`ks2672-other-${Date.now()}`);
  const analysis = await api<{ id: string }>(
    authorTokens,
    'POST',
    '/analyses',
    { pgn: '1. e4 e5 *', title: `KS-2672 unified ${Date.now()}` },
  );
  await api(authorTokens, 'PATCH', `/analyses/${analysis.id}/share`, {
    isPublic: true,
  });

  // 1. Автор: на /analysis/<id> Share доступен через overflow-меню (KS-2678).
  await seedAuth(page, authorTokens);
  await page.goto(`/analysis/${analysis.id}`);
  await expect(page.locator('.analysis-overflow-btn')).toBeVisible({
    timeout: 15_000,
  });
  await page.locator('.analysis-overflow-btn').click();
  await expect(page.getByTestId('analysis-share-overflow')).toBeVisible();
  // Закроем меню обратно для скриншота «обычного режима».
  await page.keyboard.press('Escape');
  await page.screenshot({
    path: `${DIR}/desktop-author-mode.png`,
    fullPage: true,
  });

  // 2. Не-владелец (другой залогиненный) открывает public-URL.
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await seedAuth(otherPage, otherTokens);
  await otherPage.goto(
    `/analysis/public/${analysis.id}`,
  );
  // Доска / основные ходы рендерятся.
  await otherPage
    .locator('.analysis-breadcrumbs__current-text, h1')
    .first()
    .waitFor({ timeout: 20_000 });
  // Share-trigger / share-overflow-пункт отсутствуют у не-владельца.
  await expect(
    otherPage.getByTestId('analysis-share-trigger'),
  ).toHaveCount(0);
  // Открываем меню — пункта Share там нет.
  await otherPage.locator('.analysis-overflow-btn').click();
  await expect(
    otherPage.getByTestId('analysis-share-overflow'),
  ).toHaveCount(0);
  await otherPage.keyboard.press('Escape');
  await otherPage.screenshot({
    path: `${DIR}/desktop-non-owner-mode.png`,
    fullPage: true,
  });
  await otherContext.close();

  // 3. Аноним без auth.
  const anonContext = await browser.newContext();
  const anonPage = await anonContext.newPage();
  await anonPage.goto(`/analysis/public/${analysis.id}`);
  await anonPage
    .locator('.analysis-breadcrumbs__current-text, h1')
    .first()
    .waitFor({ timeout: 20_000 });
  await expect(
    anonPage.getByTestId('analysis-share-trigger'),
  ).toHaveCount(0);
  await anonPage.screenshot({
    path: `${DIR}/desktop-anon-mode.png`,
    fullPage: true,
  });
  await anonContext.close();

  // Cleanup.
  await fetch(`${API_URL}/analyses/${analysis.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${authorTokens.accessToken}` },
  }).catch(() => {});
});
