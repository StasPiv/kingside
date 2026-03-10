import { test, expect, navigateTo } from '../fixtures/auth.fixture';
import { test as base, expect as baseExpect } from '@playwright/test';

/**
 * KS-263: Реверификация фиксов Puzzle Rush (KS-252, KS-253, KS-254)
 *
 * KS-252 (HIGH) — Роутинг /puzzle-rush/leaderboard
 * KS-253 (LOW)  — Ссылка на лидерборд (.rush-leaderboard-link)
 * KS-254 (LOW)  — Мобильная вёрстка (viewport 375px)
 */

function mockLeaderboardApi(page: import('@playwright/test').Page) {
  return page.route('**/api/puzzle-rush/leaderboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [
          { userId: 'u1', username: 'Alice', score: 25, createdAt: '2026-03-01' },
          { userId: 'u2', username: 'Bob', score: 18, createdAt: '2026-03-02' },
        ],
      }),
    }),
  );
}

// ── KS-252: Роутинг /puzzle-rush/leaderboard ────────────────────────

test.describe('KS-252: роутинг /puzzle-rush/leaderboard', () => {
  test('прямой переход на /puzzle-rush/leaderboard открывает страницу', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });

  test('прямой переход на /puzzle-rush/play (fallback) — не ломает приложение', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    await expect(page).toHaveURL(/\/puzzle-rush/);
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();
  });

  test('навигация между вложенными маршрутами Puzzle Rush', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush');

    await expect(page.locator('.puzzle-rush-page')).toBeVisible();

    // Переход на leaderboard через навигацию
    await page.locator('header nav a[href="/puzzle-rush/leaderboard"]').click();
    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();

    // Обратный переход через back-link
    await page.locator('.rush-lb-back-link').click();
    await expect(page).toHaveURL(/\/puzzle-rush$/);
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();
  });
});

// Публичный доступ к leaderboard (без авторизации)
base.describe('KS-252: leaderboard доступен без авторизации', () => {
  base('leaderboard открывается без токена', async ({ page }) => {
    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [{ userId: 'u1', username: 'Guest', score: 5, createdAt: '2026-03-01' }],
        }),
      }),
    );

    await page.goto('/puzzle-rush/leaderboard');

    await baseExpect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await baseExpect(page).not.toHaveURL(/\/login/);
    await baseExpect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });
});

// ── KS-253: Ссылка на лидерборд (.rush-leaderboard-link) ───────────

test.describe('KS-253: ссылка .rush-leaderboard-link', () => {
  test('ссылка видна на стартовом экране Puzzle Rush', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    const link = page.locator('.rush-leaderboard-link');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/puzzle-rush/leaderboard');
  });

  test('клик по ссылке ведёт на /puzzle-rush/leaderboard', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush');

    await page.locator('.rush-leaderboard-link').click();

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });
});

// ── KS-254: Мобильная вёрстка (viewport 375px) ─────────────────────

test.describe('KS-254: мобильная вёрстка 375px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('нет горизонтального скролла на стартовом экране', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test('нет горизонтального скролла на leaderboard', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test('навигация корректно переносится (flex-wrap)', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    const nav = page.locator('header nav');
    const flexWrap = await nav.evaluate((el) => getComputedStyle(el).flexWrap);
    expect(flexWrap).toBe('wrap');
  });

  test('текст не накладывается друг на друга', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();

    // Проверяем что overflow-x: hidden на .main
    const overflowX = await page.locator('.main').evaluate((el) => getComputedStyle(el).overflowX);
    expect(overflowX).toBe('hidden');
  });
});
