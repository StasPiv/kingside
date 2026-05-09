import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2674 — Share-кнопка переехала из шапки AnalysisPage в action-bar
 * под доской (desktop) и в overflow-меню (mobile).
 *
 * Проверяем:
 *  1. В шапке (рядом с breadcrumbs) нет Share-trigger / share-host.
 *  2. На desktop кнопка Share есть в action-bar — клик открывает popup.
 *  3. На mobile в overflow-меню есть пункт «Share» —
 *     клик открывает тот же popup.
 *  4. ShareAnalysisPopup работает: Make public → Public.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2674';

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

async function createAnalysis(
  tokens: Tokens,
  title: string,
): Promise<{ id: string }> {
  const res = await fetch(`${API_URL}/analyses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pgn: '1. e4 e5 *', title }),
  });
  if (!res.ok) throw new Error(`create ${res.status}`);
  return (await res.json()) as { id: string };
}

test.describe.configure({ mode: 'serial' });

test('KS-2674: на desktop Share в action-bar, в шапке нет', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'Только desktop-проект.',
  );
  const tokens = await devBypass(`ks2674-desktop-${Date.now()}`);
  const analysis = await createAnalysis(
    tokens,
    `KS-2674 desktop ${Date.now()}`,
  );
  await seedAuth(page, tokens);
  await page.goto(`/analysis/${analysis.id}`);

  // 1. Share-trigger существует, но в action-bar (`.analysis-board-controls`),
  //    а НЕ в шапке (`.analysis-share-host` удалён).
  await expect(page.getByTestId('analysis-share-trigger')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('.analysis-share-host')).toHaveCount(0);
  // Trigger находится внутри action-bar.
  const triggerInActionBar = page.locator(
    '.analysis-board-controls [data-testid="analysis-share-trigger"]',
  );
  await expect(triggerInActionBar).toBeVisible();

  // 2. Клик открывает popup.
  await page.getByTestId('analysis-share-trigger').click();
  await expect(page.getByTestId('analysis-share-popup')).toBeVisible();
  await expect(page.getByTestId('analysis-share-state')).toContainText(
    /Private/i,
  );
  await page.screenshot({
    path: `${DIR}/desktop-share-from-actionbar.png`,
    fullPage: true,
  });

  // 3. Make public работает как раньше.
  await page.getByTestId('analysis-share-toggle').click();
  await expect(page.getByTestId('analysis-share-state')).toContainText(
    /Public/i,
    { timeout: 10_000 },
  );

  await fetch(`${API_URL}/analyses/${analysis.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  }).catch(() => {});
});

test('KS-2674: на mobile Share открывается из overflow-меню', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'mobile',
    'Только mobile-проект.',
  );
  const tokens = await devBypass(`ks2674-mobile-${Date.now()}`);
  const analysis = await createAnalysis(
    tokens,
    `KS-2674 mobile ${Date.now()}`,
  );
  await seedAuth(page, tokens);
  await page.goto(`/analysis/${analysis.id}`);

  // 1. Видимый trigger в шапке отсутствует (был `.analysis-share-host`).
  await expect(page.locator('.analysis-share-host')).toHaveCount(0);

  // 2. Дождёмся загрузки — overflow-кнопка должна появиться.
  await expect(page.locator('.analysis-overflow-btn')).toBeVisible({
    timeout: 15_000,
  });

  // 3. Скриншот «до»: меню закрыто, шапка и доска без Share-баннера.
  await page.screenshot({
    path: `${DIR}/mobile-before-menu.png`,
    fullPage: true,
  });

  // 4. Открываем overflow-меню → виден пункт «Share» (он рендерится
  //    только при открытом меню).
  await page.locator('.analysis-overflow-btn').click();
  const shareItem = page.getByTestId('analysis-share-overflow');
  await expect(shareItem).toBeVisible({ timeout: 5_000 });
  await page.screenshot({
    path: `${DIR}/mobile-overflow-menu-open.png`,
    fullPage: true,
  });

  // 5. Клик по пункту → меню закрывается, popup открывается.
  await shareItem.click();
  await expect(page.getByTestId('analysis-share-popup')).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByTestId('analysis-share-state')).toContainText(
    /Private/i,
  );
  await page.screenshot({
    path: `${DIR}/mobile-share-popup.png`,
    fullPage: true,
  });

  await fetch(`${API_URL}/analyses/${analysis.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  }).catch(() => {});
});
