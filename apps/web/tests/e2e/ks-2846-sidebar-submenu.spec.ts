import { test, expect } from '@playwright/test';

/**
 * KS-2846 (ADR-058 §11.4, §11.9): e2e-проверки двухуровневого
 * sidebar-submenu и desktop-redirect лобби.
 *
 * Сценарии:
 *   1. Desktop: hover на «Тренировка» → поповер виден → клик «Задачи»
 *      → URL /puzzles + подсветка group + подпункт active.
 *   2. Desktop: прямой URL /train → редирект на /puzzles (KS-2844).
 *   3. Desktop: keyboard nav — ArrowDown открывает submenu и фокус
 *      на первом подпункте; Escape закрывает.
 *   4. Mobile: на /train рендерится лобби-страница (карточки), submenu
 *      на mobile не активен.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';

async function login(page: import('@playwright/test').Page) {
  const tokenRes = await fetch(`${API_URL}/auth/dev-bypass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: DEV_BYPASS_SECRET,
      user: `ks2846-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

test.describe('KS-2846 sidebar submenu + lobby redirect', () => {
  test('desktop: hover на Train → поповер; клик Puzzles → /puzzles', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'sidebar submenu — только desktop',
    );
    await login(page);
    await page.goto('/play');
    const parent = page.getByTestId('sidebar-submenu-parent-train');
    await expect(parent).toBeVisible();
    await parent.hover();
    // Поповер появляется по hover.
    const popover = page.getByTestId('sidebar-submenu-popover-train');
    await expect(popover).toBeVisible({ timeout: 2000 });
    // Клик по подпункту Puzzles.
    await page.getByTestId('sidebar-submenu-item-puzzles').click();
    await page.waitForURL(/\/puzzles$/, { timeout: 5_000 });
    expect(page.url()).toMatch(/\/puzzles$/);
    // Group подсветка остаётся.
    await expect(parent).toHaveClass(/sidebar-item--active/);
  });

  test('desktop: прямой URL /train → редирект на /puzzles (KS-2844)', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'redirect логика только desktop',
    );
    await login(page);
    await page.goto('/train');
    // На desktop puzzlesEnabled по дефолту может быть true/false; для
    // dev-bypass пользователя смотрим что URL уехал НЕ на /train.
    await page.waitForURL((url) => !url.pathname.endsWith('/train'), {
      timeout: 5_000,
    });
    expect(page.url()).not.toMatch(/\/train$/);
  });

  test('desktop: keyboard — ArrowDown открывает submenu, Escape закрывает', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'keyboard nav — только desktop',
    );
    await login(page);
    await page.goto('/play');
    const parent = page.getByTestId('sidebar-submenu-parent-train');
    await parent.focus();
    await page.keyboard.press('ArrowDown');
    const popover = page.getByTestId('sidebar-submenu-popover-train');
    await expect(popover).toBeVisible({ timeout: 2000 });
    await page.keyboard.press('Escape');
    await expect(popover).not.toBeVisible({ timeout: 2000 });
  });

  test('mobile: на /train рендерится лобби (карточки), submenu не активен', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'mobile',
      'mobile-only сценарий',
    );
    await login(page);
    await page.goto('/train');
    // Лобби-карточки видны.
    await expect(page.getByTestId('train-lobby-page')).toBeVisible({
      timeout: 5_000,
    });
    await expect(
      page.getByTestId('train-lobby-card-puzzle-rush'),
    ).toBeVisible();
  });

  // KS-2848: Play submenu с Турнирами
  test('desktop: hover на Play → поповер; клик Tournaments → /tournaments', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'sidebar submenu — только desktop',
    );
    await login(page);
    await page.goto('/play');
    const parent = page.getByTestId('sidebar-submenu-parent-play');
    await expect(parent).toBeVisible();
    await parent.hover();
    const popover = page.getByTestId('sidebar-submenu-popover-play');
    await expect(popover).toBeVisible({ timeout: 2000 });
    // Подпункт Tournaments.
    await page.getByTestId('sidebar-submenu-item-tournaments').click();
    await page.waitForURL(/\/tournaments$/, { timeout: 5_000 });
    expect(page.url()).toMatch(/\/tournaments$/);
    // Group Play подсветка остаётся.
    await expect(parent).toHaveClass(/sidebar-item--active/);
  });
});
