import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2669 — Share button visible to author on desktop AND mobile.
 *
 * Регрессия: KS-2666 поместил Share-кнопку в `<nav class=
 * "analysis-breadcrumbs">`, но этот блок скрыт CSS на mobile
 * (KS-1175 `display: none`). KS-2669 вынес Share в собственный host
 * `.analysis-share-host` со своими mobile-стилями — кнопка теперь
 * видна на обоих breakpoint'ах.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2669';

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

test('KS-2669: кнопка Share видна автору на /analysis/<id>', async ({
  page,
}, testInfo) => {
  const proj = testInfo.project.name;
  const tokens = await devBypass(`ks2669-${proj}-${Date.now()}`);
  const analysis = await createAnalysis(
    tokens,
    `KS-2669 share visible ${proj} ${Date.now()}`,
  );
  await seedAuth(page, tokens);

  await page.goto(`/analysis/${analysis.id}`);
  // Host-контейнер — точка проверки видимости.
  await expect(page.getByTestId('analysis-share-host')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('analysis-share-trigger')).toBeVisible();

  // Открытие popup'а — sanity: на mobile он тоже не должен уехать
  // за края экрана (CSS-rules для mobile применяются).
  await page.getByTestId('analysis-share-trigger').click();
  await expect(page.getByTestId('analysis-share-popup')).toBeVisible();

  await page.screenshot({
    path: `${DIR}/${proj}-share-button-visible.png`,
    fullPage: true,
  });

  // Cleanup.
  await fetch(`${API_URL}/analyses/${analysis.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  }).catch(() => {});
});
