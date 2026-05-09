import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2661 — скриншоты:
 *  1. /precision — кнопка «Generate from PGN» в шапке + табы
 *     «All / My puzzles».
 *  2. /precision?mine=true — таб «Мои» активен.
 *  3. /puzzles — кнопки «Generate from PGN» больше нет.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2661';

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

test('KS-2661: generator + tabs на /precision, нет генератора в /puzzles', async ({
  page,
}, testInfo) => {
  const proj = testInfo.project.name;
  const tokens = await devBypass(`ks2661-${proj}-${Date.now()}`);
  await seedAuth(page, tokens);

  // 1. /precision — кнопка генератора + табы.
  await page.goto('/precision');
  await page.getByTestId('play-vs-engine-puzzles').waitFor({ timeout: 15_000 });
  await expect(page.getByTestId('precision-generate-btn')).toBeVisible();
  await expect(page.getByTestId('precision-tab-all')).toBeVisible();
  await expect(page.getByTestId('precision-tab-mine')).toBeVisible();
  await page.screenshot({
    path: `${DIR}/${proj}-precision-all.png`,
    fullPage: true,
  });

  // 2. Клик «My puzzles» → URL `?mine=true` + tab активен.
  await page.getByTestId('precision-tab-mine').click();
  await page.waitForURL(/\?mine=true$/, { timeout: 5_000 });
  await page.screenshot({
    path: `${DIR}/${proj}-precision-mine.png`,
    fullPage: true,
  });

  // 3. /puzzles — кнопки «Generate from PGN» больше НЕТ.
  await page.goto('/puzzles');
  await page.getByTestId('puzzle-browser-page').waitFor({ timeout: 15_000 });
  const generateButtons = await page
    .locator('button.generate-puzzles-btn')
    .count();
  if (generateButtons !== 0) {
    throw new Error(
      `expected 0 generate-puzzles-btn in /puzzles, got ${generateButtons}`,
    );
  }
  await page.screenshot({
    path: `${DIR}/${proj}-puzzles-no-generator.png`,
    fullPage: true,
  });
});
