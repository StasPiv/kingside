import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2682 — Share popup: при приватном анализе НЕТ поля URL и кнопки
 * «Скопировать ссылку». После «Сделать публичным» — появляются.
 * После «Сделать приватным» обратно — исчезают.
 *
 * Используем тот же overflow-меню flow, что и в KS-2674/2678.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2682';

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

async function openSharePopup(page: Page): Promise<void> {
  await expect(page.locator('.analysis-overflow-btn')).toBeVisible({
    timeout: 15_000,
  });
  await page.locator('.analysis-overflow-btn').click();
  await page.getByTestId('analysis-share-overflow').click();
  await expect(page.getByTestId('analysis-share-popup')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('KS-2682: при приватном анализе нет URL/Copy; появляются после Make public; исчезают после Make private', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'Достаточно одного desktop-прогона.',
  );
  const tokens = await devBypass(`ks2682-${Date.now()}`);
  const analysis = await createAnalysis(
    tokens,
    `KS-2682 share-private ${Date.now()}`,
  );
  await seedAuth(page, tokens);
  await page.goto(`/analysis/${analysis.id}`);

  // 1. Открываем popup — анализ ПРИВАТНЫЙ.
  await openSharePopup(page);
  await expect(page.getByTestId('analysis-share-state')).toContainText(
    /Private/i,
  );

  // 2. Acceptance: при приватном НЕТ ни поля URL, ни кнопки Copy.
  await expect(page.getByTestId('analysis-share-url')).toHaveCount(0);
  await expect(page.getByTestId('analysis-share-copy')).toHaveCount(0);
  // Toggle-кнопка ЕСТЬ и говорит «Make public».
  const toggle = page.getByTestId('analysis-share-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toContainText(/Make public/i);
  await page.screenshot({
    path: `${DIR}/desktop-popup-private.png`,
    fullPage: true,
  });

  // 3. Make public → URL и Copy появляются.
  await toggle.click();
  await expect(page.getByTestId('analysis-share-state')).toContainText(
    /Public/i,
    { timeout: 10_000 },
  );
  await expect(page.getByTestId('analysis-share-url')).toBeVisible();
  await expect(page.getByTestId('analysis-share-copy')).toBeVisible();
  await expect(toggle).toContainText(/Make private/i);
  await page.screenshot({
    path: `${DIR}/desktop-popup-public.png`,
    fullPage: true,
  });

  // 4. Make private обратно → URL и Copy снова исчезают.
  await toggle.click();
  await expect(page.getByTestId('analysis-share-state')).toContainText(
    /Private/i,
    { timeout: 10_000 },
  );
  await expect(page.getByTestId('analysis-share-url')).toHaveCount(0);
  await expect(page.getByTestId('analysis-share-copy')).toHaveCount(0);
  await expect(toggle).toContainText(/Make public/i);

  await fetch(`${API_URL}/analyses/${analysis.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  }).catch(() => {});
});
