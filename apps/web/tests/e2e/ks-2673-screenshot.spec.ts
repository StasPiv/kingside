import { test, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2673 — скриншоты /precision?mine=true в RU и EN. На dev backend
 * не позволяет POST /puzzles напрямую, поэтому мы делаем смоук —
 * страница открывается, фильтр применён. Само наличие иконок (Publish
 * icon, тооltip-aria) проверяется unit-тестами (PrecisionPage.test.tsx).
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2673';

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

async function seedAuth(
  page: Page,
  tokens: Tokens,
  locale: 'ru' | 'en',
): Promise<void> {
  await page.addInitScript(
    ([a, r, loc]) => {
      localStorage.setItem('token', a);
      localStorage.setItem('refreshToken', r);
      localStorage.setItem('locale', loc);
    },
    [tokens.accessToken, tokens.refreshToken, locale] as [
      string,
      string,
      string,
    ],
  );
}

test.describe.configure({ mode: 'serial' });

for (const locale of ['ru', 'en'] as const) {
  test(`KS-2673: /precision?mine=true смоук (${locale})`, async ({ page }, testInfo) => {
    const proj = testInfo.project.name;
    const tokens = await devBypass(`ks2673-${locale}-${proj}-${Date.now()}`);
    await seedAuth(page, tokens, locale);
    await page.goto('/precision?mine=true');
    await page
      .getByTestId('play-vs-engine-puzzles')
      .waitFor({ timeout: 15_000 });
    await page.screenshot({
      path: `${DIR}/${proj}-precision-mine-${locale}.png`,
      fullPage: true,
    });
  });
}
