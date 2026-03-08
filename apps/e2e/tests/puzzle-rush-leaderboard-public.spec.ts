import { test, expect, navigateTo } from '../fixtures/auth.fixture';
import { test as base } from '@playwright/test';
import { API_URL } from '../fixtures/test-data';

/**
 * KS-246: Верификация фикса KS-238 — /puzzle-rush/leaderboard публичный роут
 *
 * Сценарии:
 * 1. Неавторизованный пользователь открывает /puzzle-rush/leaderboard — без редиректа
 * 2. Пользователь с истёкшим токеном — страница отображается без редиректа
 * 3. Авторизованный пользователь — страница отображается корректно
 * 4. Защищённые эндпоинты (start, session, solve, endSession, best) требуют авторизацию
 * 5. Маршрутизация: /puzzle-rush/leaderboard не конфликтует с /puzzle-rush
 */

function mockLeaderboardApi(page: import('@playwright/test').Page) {
  return page.route('**/api/puzzle-rush/leaderboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [
          { userId: 'u1', username: 'Alice', score: 30, createdAt: '2026-01-01' },
          { userId: 'u2', username: 'Bob', score: 20, createdAt: '2026-01-02' },
        ],
      }),
    }),
  );
}

// --- Сценарий 1: Неавторизованный пользователь ---

base.describe('KS-246 Scenario 1: unauthenticated user accesses leaderboard', () => {
  base('1.1 page loads without redirect to /login', async ({ page }) => {
    await mockLeaderboardApi(page);
    await page.goto('/puzzle-rush/leaderboard');

    await base.expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await base.expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });

  base('1.2 leaderboard data is displayed for unauthenticated user', async ({ page }) => {
    await mockLeaderboardApi(page);
    await page.goto('/puzzle-rush/leaderboard');

    await base.expect(page.locator('.rush-lb-row')).toHaveCount(2);
    await base.expect(page.locator('.rush-lb-row .rush-lb-col-name').first()).toHaveText('Alice');
  });

  base('1.3 API request is made without auth token', async ({ page }) => {
    const requests: string[] = [];

    await page.route('**/api/puzzle-rush/leaderboard*', (route) => {
      requests.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries: [] }),
      });
    });

    await page.goto('/puzzle-rush/leaderboard');
    await base.expect(page.locator('.rush-leaderboard-page')).toBeVisible();
    expect(requests.length).toBeGreaterThanOrEqual(1);
  });
});

// --- Сценарий 2: Пользователь с истёкшим токеном ---

base.describe('KS-246 Scenario 2: expired token user accesses leaderboard', () => {
  base('2.1 page loads with expired token without redirect', async ({ page }) => {
    // Inject an expired JWT token
    await page.addInitScript(() => {
      // Expired JWT (exp in the past)
      const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
      const payload = btoa(JSON.stringify({
        sub: 'expired-user-id',
        username: 'expireduser',
        exp: Math.floor(Date.now() / 1000) - 3600, // expired 1 hour ago
      }));
      const fakeToken = `${header}.${payload}.fakesignature`;
      localStorage.setItem('token', fakeToken);
    });

    await mockLeaderboardApi(page);
    await page.goto('/puzzle-rush/leaderboard');

    await base.expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await base.expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });
});

// --- Сценарий 3: Авторизованный пользователь ---

test.describe('KS-246 Scenario 3: authenticated user accesses leaderboard', () => {
  test('3.1 page loads correctly for authenticated user', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
    await expect(page.locator('.rush-leaderboard-page h1')).toBeVisible();
  });

  test('3.2 leaderboard table displays data', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page.locator('.rush-lb-row')).toHaveCount(2);
    await expect(page.locator('.rush-lb-mode-tabs')).toBeVisible();
    await expect(page.locator('.rush-lb-back-link')).toBeVisible();
  });
});

// --- Сценарий 4: Защищённые эндпоинты требуют авторизацию ---

base.describe('KS-246 Scenario 4: protected endpoints require auth', () => {
  const protectedEndpoints = [
    { method: 'POST', path: '/api/puzzle-rush/start', body: { timeMode: '3' } },
    { method: 'GET', path: '/api/puzzle-rush/session' },
    { method: 'POST', path: '/api/puzzle-rush/solve', body: { uci: 'e2e4' } },
    { method: 'DELETE', path: '/api/puzzle-rush/session' },
    { method: 'GET', path: '/api/puzzle-rush/best?timeMode=3' },
  ];

  for (const endpoint of protectedEndpoints) {
    base(`4.x ${endpoint.method} ${endpoint.path} returns 401 without auth`, async ({ page }) => {
      const response = await page.request.fetch(`${API_URL}${endpoint.path}`, {
        method: endpoint.method,
        data: endpoint.body,
      });

      base.expect(response.status()).toBe(401);
    });
  }

  base('4.6 GET /api/puzzle-rush/leaderboard returns 200 without auth (public)', async ({ page }) => {
    const response = await page.request.get(`${API_URL}/api/puzzle-rush/leaderboard?timeMode=3`);

    base.expect(response.status()).toBe(200);
  });
});

// --- Сценарий 5: Маршрутизация не конфликтует ---

test.describe('KS-246 Scenario 5: routing — no conflict between /puzzle-rush and /puzzle-rush/leaderboard', () => {
  test('5.1 /puzzle-rush loads PuzzleRushPage (not leaderboard)', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    await expect(page).toHaveURL(/\/puzzle-rush$/);
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();
    await expect(page.locator('.rush-leaderboard-page')).not.toBeVisible();
  });

  test('5.2 /puzzle-rush/leaderboard loads leaderboard (not puzzle-rush)', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
    await expect(page.locator('.puzzle-rush-page')).not.toBeVisible();
  });

  test('5.3 navigation from leaderboard back to puzzle-rush works', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await page.locator('.rush-lb-back-link').click();
    await expect(page).toHaveURL(/\/puzzle-rush$/);
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();
  });
});
