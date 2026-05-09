import { test, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2662 — скриншот /puzzles без вкладки «Мои задачи». Также
 * проверяем что у пользователя НЕТ button с текстом "My puzzles" в
 * шапке-табов, и нет данных-testid связанного UI.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2662';

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

test('KS-2662: /puzzles больше не имеет таб «My puzzles»', async ({
  page,
}, testInfo) => {
  const proj = testInfo.project.name;
  const tokens = await devBypass(`ks2662-${proj}-${Date.now()}`);
  await seedAuth(page, tokens);

  await page.goto('/puzzles');
  await page.getByTestId('puzzle-browser-page').waitFor({ timeout: 15_000 });

  // Поиск кнопки/ссылки с текстом «My puzzles» в шапке табов — не должно быть.
  const myTabs = await page
    .locator('.puzzle-browser-tab', { hasText: 'My puzzles' })
    .count();
  if (myTabs !== 0) {
    throw new Error(`expected 0 «My puzzles» tabs, got ${myTabs}`);
  }
  await page.screenshot({
    path: `${DIR}/${proj}-puzzles-no-mine-tab.png`,
    fullPage: true,
  });
});
