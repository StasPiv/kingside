import { test, expect, navigateTo } from '../fixtures/auth.fixture';
import { test as base } from '@playwright/test';

/**
 * KS-256: E2E верификация фикса роутинга KS-252
 *
 * KS-252 заменил вложенную структуру маршрутов puzzle-rush на плоскую:
 *   До:  <Route path="/puzzle-rush"> <Route index .../> <Route path="leaderboard" .../> </Route>
 *   После: <Route path="/puzzle-rush" .../> <Route path="/puzzle-rush/leaderboard" .../>
 *
 * Сценарии верификации:
 * 1. Прямой переход по URL /puzzle-rush/leaderboard — страница открывается
 * 2. Прямой переход по URL /puzzle-rush — страница открывается
 * 3. Навигация /puzzle-rush → /puzzle-rush/leaderboard через UI
 * 4. Навигация /puzzle-rush/leaderboard → /puzzle-rush через UI
 * 5. Обновление страницы (F5) на /puzzle-rush/leaderboard — страница не падает
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

test.describe('KS-256: Верификация фикса KS-252 — роутинг puzzle-rush', () => {
  // Сценарий 1
  test('прямой переход /puzzle-rush/leaderboard открывает страницу', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });

  // Сценарий 2
  test('прямой переход /puzzle-rush открывает страницу', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    await expect(page).toHaveURL(/\/puzzle-rush$/);
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();
  });

  // Сценарий 3
  test('навигация /puzzle-rush → /puzzle-rush/leaderboard через UI', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush');
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();

    // Ссылка на leaderboard внутри страницы puzzle-rush
    await page.locator('.rush-leaderboard-link').click();

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });

  // Сценарий 4
  test('навигация /puzzle-rush/leaderboard → /puzzle-rush через UI', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();

    // Обратная ссылка на puzzle-rush
    await page.locator('.rush-lb-back-link').click();

    await expect(page).toHaveURL(/\/puzzle-rush$/);
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();
  });

  // Сценарий 5
  test('F5 на /puzzle-rush/leaderboard — страница не падает', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();

    // Перезагрузка страницы
    await page.reload();
    await page.getByText(/logout|выйти/i).waitFor({ timeout: 10_000 });

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page).not.toHaveURL(/\/lobby/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });
});

// Публичный доступ без авторизации
base.describe('KS-256: Leaderboard доступен публично', () => {
  base('leaderboard открывается без авторизации', async ({ page }) => {
    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [
            { userId: 'u1', username: 'Public', score: 10, createdAt: '2026-03-01' },
          ],
        }),
      }),
    );

    await page.goto('/puzzle-rush/leaderboard');

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });
});
