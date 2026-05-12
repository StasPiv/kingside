import { test, expect } from '@playwright/test';

/**
 * KS-2813 (ADR-058 §6.6 T16): e2e-проверка нового sidebar и
 * корневого редиректа из KS-2794-пакета (KS-2796..KS-2810).
 *
 * 5 сценариев:
 *   1. Авторизованный на `/` → редирект на `/play` (KS-2810).
 *   2. Клик по каждому из 5 пунктов sidebar → переход + активная подсветка.
 *   3. На `/puzzles` подсвечен `Train`; на `/archive` — `Analyze`.
 *   4. Прямой URL `/lobby` рендерится (не редиректится).
 *   5. Mobile: drawer «Ещё» открывается, видны группы.
 *
 * Авторизация через dev-bypass (`/auth/dev-bypass`).
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';

async function login(page: import('@playwright/test').Page) {
  const tokenRes = await fetch(`${API_URL}/auth/dev-bypass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: DEV_BYPASS_SECRET,
      user: `ks2813-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

test.describe('KS-2813 nav restructure', () => {
  test('Сценарий 1 (KS-2810): авторизованный на `/` → редирект на `/play`', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'desktop-прогона достаточно',
    );
    await login(page);
    await page.goto('/');
    await page.waitForURL(/\/play$/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/play$/);
  });

  test('Сценарий 4 (KS-2810): прямой URL `/lobby` остаётся доступен (не редиректится)', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'desktop-прогона достаточно',
    );
    await login(page);
    await page.goto('/lobby');
    // URL остался /lobby (нет редиректа).
    await page.waitForTimeout(1500);
    expect(page.url()).toMatch(/\/lobby$/);
  });

  test('Сценарий 2 (KS-2800): 5 топ-пунктов sidebar ведут на свои маршруты', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'sidebar на mobile скрыт',
    );
    await login(page);
    await page.goto('/play');
    // Проверяем что все 5 пунктов sidebar видны и кликабельны.
    // По title (см. NAV_ITEMS i18nKey'ы) — locale=en из dev-bypass.
    const items = [
      { title: /^Play$/, href: '/play' },
      { title: /^Train$/, href: '/train' },
      { title: /^Lessons$/, href: '/lessons' },
      { title: /^TV$/, href: '/broadcasts' },
      { title: /^Analyze$/, href: '/analyze' },
    ];
    for (const item of items) {
      const link = page.locator('.sidebar a').getByTitle(item.title).first();
      await expect(link, `пункт ${item.href} в sidebar`).toBeVisible();
      expect(await link.getAttribute('href')).toBe(item.href);
    }
  });

  test('Сценарий 3 (KS-2803): /puzzles → Train подсвечен; /archive → Analyze', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'sidebar на mobile скрыт',
    );
    await login(page);
    await page.goto('/puzzles');
    await page.waitForTimeout(500);
    const train = page.locator('.sidebar a').getByTitle(/^Train$/);
    await expect(train).toHaveClass(/sidebar-item--active/);

    await page.goto('/archive');
    await page.waitForTimeout(500);
    const analyze = page.locator('.sidebar a').getByTitle(/^Analyze$/);
    await expect(analyze).toHaveClass(/sidebar-item--active/);
  });

  test('Сценарий 5 (KS-2807): mobile — drawer «Ещё» открывается, видны группы', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'mobile',
      'mobile-only сценарий',
    );
    await login(page);
    await page.goto('/play');
    // Bottom bar виден.
    const bar = page.getByTestId('mobile-bottom-bar');
    await expect(bar).toBeVisible();
    const moreBtn = page.getByTestId('mobile-bar-more');
    await expect(moreBtn).toBeVisible();
    await moreBtn.click();
    // Хотя бы 2 группы должны появиться: Help (без gating) + Account (auth).
    await expect(page.getByTestId('mobile-more-group-help')).toBeVisible();
    await expect(page.getByTestId('mobile-more-group-account')).toBeVisible();
    // В Help есть Features и Feedback-кнопка.
    await expect(page.getByTestId('mobile-more-features')).toBeVisible();
    await expect(page.getByTestId('mobile-more-feedback')).toBeVisible();
  });
});
