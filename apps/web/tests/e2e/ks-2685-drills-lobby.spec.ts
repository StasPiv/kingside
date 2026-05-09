import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2685 — лобби тренажёров `/drills`: в каждой карточке (и в CTA
 * «Спринт») рендерится мини-доска с FEN/arrows/squares.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2685';

fs.mkdirSync(DIR, { recursive: true });

async function seed(page: Page): Promise<void> {
  const tokenRes = await fetch(`${API_URL}/auth/dev-bypass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: DEV_BYPASS_SECRET,
      user: `ks2685-${Date.now()}`,
    }),
  });
  const { accessToken, refreshToken } = (await tokenRes.json()) as {
    accessToken: string;
    refreshToken: string;
  };
  await page.addInitScript(
    ([a, r]) => {
      localStorage.setItem('token', a);
      localStorage.setItem('refreshToken', r);
      localStorage.setItem('locale', 'en');
    },
    [accessToken, refreshToken] as [string, string],
  );
}

test('KS-2685: drills lobby рендерит мини-доски в карточках и CTA «Спринт»', async ({
  page,
}, testInfo) => {
  await seed(page);
  await page.goto('/drills');
  await page.getByTestId('drills-lobby').waitFor({ timeout: 15_000 });

  // Карточки с preview есть — у каждой type-card data-has-preview="true"
  // должно быть >= 1 (для разблокированных типов из catalog).
  const cards = page.locator('[data-testid="drill-type-card"][data-has-preview="true"]');
  const previewCount = await cards.count();
  expect(previewCount).toBeGreaterThan(0);

  // Sprint CTA имеет preview.
  await expect(
    page.getByTestId('drills-lobby-sprint-preview'),
  ).toBeVisible();

  const proj = testInfo.project.name;
  await page.screenshot({
    path: `${DIR}/${proj}-lobby.png`,
    fullPage: true,
  });
});
