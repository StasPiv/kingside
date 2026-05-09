import { test, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2663 — скриншот вкладки «Мои» в /precision. Backend на dev не
 * имеет API-эндпоинта для прямого создания пазла (POST /puzzles
 * → 404), поэтому здесь только смоук: открываем /precision?mine=true
 * и делаем скриншот пустого/непустого состояния. Регрессия логики
 * видимости owner-кнопок покрыта unit-тестом
 * `pages/PrecisionPage.test.tsx`.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2663';

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

test('KS-2663: /precision?mine=true смоук-скриншот', async ({
  page,
}, testInfo) => {
  const proj = testInfo.project.name;
  const tokens = await devBypass(`ks2663-${proj}-${Date.now()}`);
  await seedAuth(page, tokens);

  await page.goto('/precision?mine=true');
  await page
    .getByTestId('play-vs-engine-puzzles')
    .waitFor({ timeout: 15_000 });
  await page.screenshot({
    path: `${DIR}/${proj}-precision-mine-tab.png`,
    fullPage: true,
  });
});
