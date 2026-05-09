import { test, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2671 — скриншоты иконочной кнопки Share + локализованного popup
 * на desktop+mobile, RU+EN.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2671';

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

async function probeShare(page: Page, locale: 'ru' | 'en') {
  const proj = test.info().project.name;
  await page.getByTestId('analysis-share-trigger').click();
  await page.getByTestId('analysis-share-popup').waitFor();
  await page.screenshot({
    path: `${DIR}/${proj}-share-${locale}.png`,
    fullPage: true,
  });
}

test.describe.configure({ mode: 'serial' });

for (const locale of ['ru', 'en'] as const) {
  test(`KS-2671: иконка Share + popup на ${locale}`, async ({ page }) => {
    const tokens = await devBypass(`ks2671-${locale}-${Date.now()}`);
    const analysis = await createAnalysis(
      tokens,
      `KS-2671 i18n ${locale} ${Date.now()}`,
    );
    await seedAuth(page, tokens, locale);
    await page.goto(`/analysis/${analysis.id}`);
    await page.getByTestId('analysis-share-trigger').waitFor({ timeout: 15_000 });
    await probeShare(page, locale);
    // Cleanup.
    await fetch(`${API_URL}/analyses/${analysis.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    }).catch(() => {});
  });
}
