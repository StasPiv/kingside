import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2666 — share analysis flow:
 *  1. Автор создаёт анализ через REST.
 *  2. Открывает /analysis/<id> → видит кнопку «Share».
 *  3. Кликает Share → открывается popup, состояние «Private».
 *  4. Жмёт «Make public» → backend PATCH /analyses/:id/share, popup
 *     меняет состояние на «Public», тост «published».
 *  5. Копирует ссылку (clipboard read через page.evaluate).
 *  6. Аноним (без auth) открывает `/analysis/public/<id>` — видит
 *     read-only страницу с PGN.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2666';

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
    body: JSON.stringify({ pgn: '1. e4 e5 2. Nf3 *', title }),
  });
  if (!res.ok) throw new Error(`create ${res.status}`);
  return (await res.json()) as { id: string };
}

async function grantClipboard(page: Page): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://localhost:5173',
  });
}

test.describe.configure({ mode: 'serial' });

test('KS-2666: автор делает анализ публичным и копирует ссылку, аноним смотрит read-only', async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'Достаточно одного desktop-прогона.',
  );
  const tokens = await devBypass(`ks2666-${Date.now()}`);
  const analysis = await createAnalysis(
    tokens,
    `KS-2666 share probe ${Date.now()}`,
  );
  await seedAuth(page, tokens);
  await grantClipboard(page);

  // 1. Автор открывает страницу анализа — кнопка Share УБРАНА из шапки
  //    и action-bar (KS-2678), доступна только из overflow-меню «…».
  await page.goto(`/analysis/${analysis.id}`);
  await expect(page.locator('.analysis-overflow-btn')).toBeVisible({
    timeout: 15_000,
  });

  // 2. Открываем overflow-меню → пункт Share → popup с состоянием Private.
  await page.locator('.analysis-overflow-btn').click();
  await page.getByTestId('analysis-share-overflow').click();
  await expect(page.getByTestId('analysis-share-popup')).toBeVisible();
  await expect(page.getByTestId('analysis-share-state')).toContainText(
    /Private/i,
  );

  // 3. Make public.
  const [shareRes] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === 'PATCH' &&
        new RegExp(`/analyses/${analysis.id}/share$`).test(r.url()),
      { timeout: 10_000 },
    ),
    page.getByTestId('analysis-share-toggle').click(),
  ]);
  expect(shareRes.ok(), `PATCH share: ${shareRes.status()}`).toBe(true);
  await expect(page.getByTestId('analysis-share-state')).toContainText(
    /Public/i,
  );

  // 4. Copy link → clipboard.
  await page.getByTestId('analysis-share-copy').click();
  const clipboardText = await page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  });
  const expectedUrl = `http://localhost:5173/analysis/public/${analysis.id}`;
  expect(clipboardText).toBe(expectedUrl);

  await page.screenshot({
    path: `${DIR}/desktop-share-popup-public.png`,
    fullPage: true,
  });

  // 5. Аноним (без auth) открывает публичную ссылку — read-only.
  // KS-2672: вместо отдельной PublicAnalysisPage теперь тот же
  // AnalysisPage с `publicMode=true` — рендерит доску, ходы,
  // навигацию. Owner-actions скрыты (нет Share-кнопки).
  const anonContext = await browser.newContext();
  const anonPage = await anonContext.newPage();
  await anonPage.goto(expectedUrl);
  // Анонимная страница загружается с задержкой (Stockfish init), но
  // breadcrumb/title должен прийти быстро.
  await anonPage
    .locator('.analysis-breadcrumbs__current-text, h1')
    .first()
    .waitFor({ timeout: 20_000 });
  // Share-кнопка анониму НЕ видна.
  await expect(
    anonPage.getByTestId('analysis-share-trigger'),
  ).toHaveCount(0);
  await anonPage.screenshot({
    path: `${DIR}/desktop-public-readonly.png`,
    fullPage: true,
  });
  await anonContext.close();

  // Cleanup.
  await fetch(`${API_URL}/analyses/${analysis.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  }).catch(() => {});
});
