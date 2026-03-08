import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * KS-245: Верификация KS-238 — лидерборд puzzle-rush без авторизации
 *
 * Сценарии:
 * 1. Неавторизованный пользователь открывает /puzzle-rush/leaderboard — страница отображается без редиректа
 * 2. Авторизованный пользователь открывает /puzzle-rush/leaderboard — текущий пользователь подсвечен
 * 3. Защищённые маршруты по-прежнему требуют авторизации (регрессия)
 */

const mockEntries = [
  { userId: 'u1', username: 'Magnus', score: 42, createdAt: '2026-01-01' },
  { userId: 'u2', username: 'Hikaru', score: 38, createdAt: '2026-01-02' },
];

function mockLeaderboardApi(page: import('@playwright/test').Page, entries = mockEntries) {
  return page.route('**/api/puzzle-rush/leaderboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries }),
    }),
  );
}

test.describe('KS-245: Верификация KS-238 — лидерборд без авторизации', () => {
  // --- Сценарий 1: Неавторизованный доступ ---

  test('1.1 неавторизованный пользователь видит страницу лидерборда без редиректа', async ({ page }) => {
    await mockLeaderboardApi(page);
    await page.goto('/puzzle-rush/leaderboard');

    // Страница НЕ должна редиректить на /login
    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
    await expect(page.locator('.rush-leaderboard-page h1')).toBeVisible();
  });

  test('1.2 неавторизованный пользователь видит таблицу с данными', async ({ page }) => {
    await mockLeaderboardApi(page);
    await page.goto('/puzzle-rush/leaderboard');

    await expect(page.locator('.rush-lb-table')).toBeVisible();
    await expect(page.locator('.rush-lb-row')).toHaveCount(2);

    const firstRow = page.locator('.rush-lb-row').first();
    await expect(firstRow.locator('.rush-lb-col-rank')).toHaveText('1');
    await expect(firstRow.locator('.rush-lb-col-name')).toHaveText('Magnus');
    await expect(firstRow.locator('.rush-lb-col-score')).toHaveText('42');
  });

  test('1.3 неавторизованный пользователь может переключать режимы 3/5 мин', async ({ page }) => {
    await page.route('**/api/puzzle-rush/leaderboard*', (route) => {
      const url = new URL(route.request().url());
      const mode = url.searchParams.get('timeMode') || '3';

      const entries = mode === '5'
        ? [{ userId: 'u1', username: 'FiveMinKing', score: 50, createdAt: '2026-01-01' }]
        : [{ userId: 'u2', username: 'ThreeMinKing', score: 45, createdAt: '2026-01-01' }];

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries }),
      });
    });

    await page.goto('/puzzle-rush/leaderboard');

    await expect(page.locator('.rush-lb-row .rush-lb-col-name').first()).toHaveText('ThreeMinKing');

    await page.locator('.rush-lb-mode-tabs .tc-btn').nth(1).click();
    await expect(page.locator('.rush-lb-row .rush-lb-col-name').first()).toHaveText('FiveMinKing');
  });

  test('1.4 неавторизованный пользователь — ни одна строка не подсвечена', async ({ page }) => {
    await mockLeaderboardApi(page);
    await page.goto('/puzzle-rush/leaderboard');

    await expect(page.locator('.rush-lb-row')).toHaveCount(2);
    await expect(page.locator('.rush-lb-row-current')).toHaveCount(0);
  });

  // --- Сценарий 2: Авторизованный доступ ---

  test('2.1 авторизованный пользователь видит страницу лидерборда', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });

  test('2.2 авторизованный пользователь подсвечен в таблице', async ({ authenticatedPage: page }) => {
    const userInfo = await page.evaluate(() => {
      const token = localStorage.getItem('token');
      if (!token) return null;
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        return { id: payload.sub || payload.id, username: payload.username };
      } catch {
        return null;
      }
    });

    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [
            { userId: 'other-user', username: 'Opponent', score: 50, createdAt: '2026-01-01' },
            { userId: userInfo?.id ?? 'current', username: userInfo?.username ?? 'me', score: 30, createdAt: '2026-01-02' },
          ],
        }),
      }),
    );

    await navigateTo(page, '/puzzle-rush/leaderboard');

    const rows = page.locator('.rush-lb-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).not.toHaveClass(/rush-lb-row-current/);
    await expect(rows.nth(1)).toHaveClass(/rush-lb-row-current/);
  });

  // --- Сценарий 3: Регрессия — защищённые маршруты ---

  test('3.1 /lobby требует авторизации', async ({ page }) => {
    await page.goto('/lobby');
    await expect(page).toHaveURL(/\/login/);
  });

  test('3.2 /puzzle-rush (index) требует авторизации', async ({ page }) => {
    await page.goto('/puzzle-rush');
    await expect(page).toHaveURL(/\/login/);
  });

  test('3.3 /settings требует авторизации', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login/);
  });

  test('3.4 /daily требует авторизации', async ({ page }) => {
    await page.goto('/daily');
    await expect(page).toHaveURL(/\/login/);
  });

  test('3.5 /puzzles требует авторизации', async ({ page }) => {
    await page.goto('/puzzles');
    await expect(page).toHaveURL(/\/login/);
  });

  test('3.6 /profile требует авторизации', async ({ page }) => {
    await page.goto('/profile');
    await expect(page).toHaveURL(/\/login/);
  });
});
