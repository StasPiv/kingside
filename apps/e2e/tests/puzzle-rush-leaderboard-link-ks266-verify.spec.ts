import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * KS-266: E2E верификация ссылки на лидерборд Puzzle Rush
 *
 * Проверяет видимость и работоспособность .rush-leaderboard-link
 * после фиксов KS-252 (роутинг) и KS-253 (ссылка на лидерборд).
 *
 * Сценарии:
 * 1. Прямой переход на /puzzle-rush — .rush-leaderboard-link видим
 * 2. Клик по ссылке на лидерборд — переход на /puzzle-rush/leaderboard
 * 3. Переход на /puzzle-rush через навигацию — ссылка отображается
 * 4. Обновление страницы /puzzle-rush (F5) — ссылка остаётся видимой
 */

function mockLeaderboardApi(page: import('@playwright/test').Page) {
  return page.route('**/api/puzzle-rush/leaderboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [
          { userId: 'u1', username: 'Alice', score: 50, createdAt: '2026-03-01' },
          { userId: 'u2', username: 'Bob', score: 45, createdAt: '2026-03-02' },
        ],
      }),
    }),
  );
}

test.describe('KS-266: Верификация ссылки на лидерборд Puzzle Rush', () => {
  // Сценарий 1
  test('прямой переход /puzzle-rush — .rush-leaderboard-link видим', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    await expect(page).toHaveURL(/\/puzzle-rush$/);
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();
    await expect(page.locator('.rush-leaderboard-link')).toBeVisible();
  });

  // Сценарий 2
  test('клик по .rush-leaderboard-link — переход на /puzzle-rush/leaderboard', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush');

    await expect(page.locator('.rush-leaderboard-link')).toBeVisible();
    await page.locator('.rush-leaderboard-link').click();

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });

  // Сценарий 3
  test('переход через навигацию — ссылка на лидерборд отображается', async ({ authenticatedPage: page }) => {
    // Начинаем с lobby (authenticatedPage уже на /lobby)
    // Переходим через навигационную ссылку на puzzle-rush
    await page.locator('nav a[href="/puzzle-rush"]').click();

    await expect(page).toHaveURL(/\/puzzle-rush$/);
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();
    await expect(page.locator('.rush-leaderboard-link')).toBeVisible();
  });

  // Сценарий 4
  test('F5 на /puzzle-rush — .rush-leaderboard-link остаётся видимой', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    await expect(page.locator('.rush-leaderboard-link')).toBeVisible();

    // Перезагрузка страницы
    await page.reload();
    await page.getByText(/logout|выйти/i).waitFor({ timeout: 10_000 });

    await expect(page).toHaveURL(/\/puzzle-rush$/);
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();
    await expect(page.locator('.rush-leaderboard-link')).toBeVisible();
  });
});
