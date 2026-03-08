import { test, expect, navigateTo } from '../fixtures/auth.fixture';
import { test as base } from '@playwright/test';

/**
 * KS-243: E2E верификация фикса роутинга /puzzle-rush/leaderboard (KS-238)
 *
 * Сценарии:
 * 1. Прямой переход на /puzzle-rush/leaderboard — страница открывается без редиректа на /lobby
 * 2. Переход на /puzzle-rush — index-страница открывается корректно
 * 3. Навигация /puzzle-rush → /puzzle-rush/leaderboard через UI
 * 4. Навигация /puzzle-rush/leaderboard → /puzzle-rush (обратный переход)
 * 5. Обновление страницы (F5) на /puzzle-rush/leaderboard — без редиректа
 * 6. Другие маршруты приложения не затронуты
 */

function mockLeaderboardApi(page: import('@playwright/test').Page) {
  return page.route('**/api/puzzle-rush/leaderboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [
          { userId: 'u1', username: 'TestPlayer1', score: 42, createdAt: '2026-01-01' },
          { userId: 'u2', username: 'TestPlayer2', score: 38, createdAt: '2026-01-02' },
        ],
      }),
    }),
  );
}

test.describe('KS-243: Верификация фикса роутинга /puzzle-rush/leaderboard', () => {
  // --- Сценарий 1: Прямой переход на /puzzle-rush/leaderboard ---

  test('1.1 прямой переход на /puzzle-rush/leaderboard открывает страницу', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });

  test('1.2 прямой переход НЕ редиректит на /lobby', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page).not.toHaveURL(/\/lobby/);
    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
  });

  // --- Сценарий 2: /puzzle-rush index-страница ---

  test('2.1 переход на /puzzle-rush открывает index-страницу', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    await expect(page).toHaveURL(/\/puzzle-rush$/);
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();
  });

  test('2.2 /puzzle-rush НЕ редиректит на /lobby', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    await expect(page).not.toHaveURL(/\/lobby/);
    await expect(page).toHaveURL(/\/puzzle-rush$/);
  });

  // --- Сценарий 3: Навигация /puzzle-rush → /puzzle-rush/leaderboard ---

  test('3.1 навигация из puzzle-rush на leaderboard через UI', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush');

    await expect(page.locator('.puzzle-rush-page')).toBeVisible();

    // Переходим на leaderboard через ссылку в навигации
    const nav = page.locator('header nav');
    await nav.locator('a[href="/puzzle-rush/leaderboard"]').click();

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });

  // --- Сценарий 4: Обратная навигация /puzzle-rush/leaderboard → /puzzle-rush ---

  test('4.1 обратная навигация через ссылку "назад"', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();

    const backLink = page.locator('.rush-lb-back-link');
    await expect(backLink).toBeVisible();
    await backLink.click();

    await expect(page).toHaveURL(/\/puzzle-rush$/);
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();
  });

  // --- Сценарий 5: Обновление страницы (F5) ---

  test('5.1 обновление страницы на /puzzle-rush/leaderboard не вызывает редирект', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();

    // Обновляем страницу (эквивалент F5)
    await page.reload();
    await page.getByText(/logout|выйти/i).waitFor({ timeout: 10_000 });

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page).not.toHaveURL(/\/lobby/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });

  // --- Сценарий 6: Другие маршруты не затронуты ---

  test('6.1 /lobby открывается корректно', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/lobby');

    await expect(page).toHaveURL(/\/lobby/);
    await expect(page.locator('.lobby-page')).toBeVisible();
  });

  test('6.2 /daily открывается корректно', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/daily');

    await expect(page).toHaveURL(/\/daily/);
    await expect(page.locator('.daily-puzzle-page')).toBeVisible();
  });

  test('6.3 /puzzles открывается корректно', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzles');

    await expect(page).toHaveURL(/\/puzzles/);
    await expect(page.locator('.puzzle-browser-page')).toBeVisible();
  });

  test('6.4 /settings открывается корректно', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/settings');

    await expect(page).toHaveURL(/\/settings/);
    await expect(page.locator('.settings-page')).toBeVisible();
  });

  test('6.5 неизвестный маршрут редиректит на /lobby', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/nonexistent-route');

    await expect(page).toHaveURL(/\/lobby/);
  });
});

// --- Публичный доступ к leaderboard (без авторизации) ---

base.describe('KS-243: Leaderboard доступен без авторизации', () => {
  base('leaderboard открывается без токена авторизации', async ({ page }) => {
    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [
            { userId: 'u1', username: 'Public', score: 10, createdAt: '2026-01-01' },
          ],
        }),
      }),
    );

    await page.goto('/puzzle-rush/leaderboard');

    // Страница должна загрузиться без редиректа на /login
    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });
});
