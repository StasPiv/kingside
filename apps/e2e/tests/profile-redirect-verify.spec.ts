import { test, expect, navigateTo } from '../fixtures/auth.fixture';
import { test as base } from '@playwright/test';
import { generateUser, API_URL } from '../fixtures/test-data';

/**
 * KS-255: E2E verification of KS-239 redirect fix for /profile.
 *
 * Scenarios:
 * 1. Authenticated user navigates to /profile → profile page opens (no redirect to /lobby)
 * 2. Unauthenticated user navigates to /profile → redirect to /login with returnUrl=/profile
 * 3. After login from /login with returnUrl=/profile → redirect back to /profile
 * 4. After login without returnUrl → redirect to /lobby (fallback)
 * 5. Other protected routes — returnUrl should work correctly
 */

const mockProfile = {
  id: 'user-1',
  username: 'TestPlayer',
  ratingBullet: 1200,
  ratingBlitz: 1350,
  ratingRapid: 1500,
  ratingClassical: 1600,
  createdAt: '2025-06-15T10:00:00Z',
  lastSeenAt: '2026-03-08T12:00:00Z',
};

const mockRushStats = { best3: 12, best5: 18, totalSessions: 5 };

function setupProfileMocks(page: import('@playwright/test').Page, userId: string) {
  return Promise.all([
    page.route(`**/api/users/${userId}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...mockProfile, id: userId }),
      }),
    ),
    page.route(`**/api/users/${userId}/games*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      }),
    ),
    page.route(`**/api/users/${userId}/puzzle-rush-stats`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockRushStats),
      }),
    ),
  ]);
}

async function getUserId(page: import('@playwright/test').Page): Promise<string> {
  const info = await page.evaluate(() => {
    const token = localStorage.getItem('token');
    if (!token) return null;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.sub || payload.id;
    } catch {
      return null;
    }
  });
  return info ?? 'unknown';
}

test.describe('KS-255: Profile redirect verification (KS-239 fix)', () => {
  // Scenario 1: Authenticated user → /profile opens without redirect to /lobby
  test('scenario 1: authenticated user sees /profile, not /lobby', async ({
    authenticatedPage: page,
  }) => {
    const userId = await getUserId(page);
    await setupProfileMocks(page, userId);
    await navigateTo(page, '/profile');

    await expect(page).toHaveURL(/\/profile/);
    await expect(page).not.toHaveURL(/\/lobby/);
    await expect(page.locator('.profile-page')).toBeVisible();
  });

  // Scenario 2: Unauthenticated user → /profile redirects to /login
  // (returnUrl is passed via React Router state, not visible in URL)
  test('scenario 2: unauthenticated user redirected to /login from /profile', async ({
    page,
  }) => {
    await page.goto('/profile');
    await expect(page).toHaveURL(/\/login/);
    await expect(page).not.toHaveURL(/\/profile/);
  });
});

// Scenarios 3-5 use raw Playwright (no auth fixture) to test the full login flow via UI
base.describe('KS-255: Login returnUrl flow verification', () => {
  let registeredUser: { username: string; email: string; password: string };

  base.beforeEach(async ({ page }) => {
    // Register a fresh user via API for each test
    registeredUser = generateUser('ks255');
    const res = await page.request.post(`${API_URL}/api/auth/register`, {
      data: {
        username: registeredUser.username,
        email: registeredUser.email,
        password: registeredUser.password,
      },
    });
    base.expect(res.ok()).toBeTruthy();
  });

  // Scenario 3: Navigate to /profile unauthenticated → login → should redirect back to /profile
  base.test('scenario 3: login with returnUrl redirects back to /profile', async ({ page }) => {
    // Go to /profile while unauthenticated — should redirect to /login
    await page.goto('/profile');
    await base.expect(page).toHaveURL(/\/login/);

    // Fill login form and submit
    await page.fill('input[type="text"]', registeredUser.username);
    await page.fill('input[type="password"]', registeredUser.password);
    await page.click('button[type="submit"]');

    // After login, should redirect to /profile (returnUrl), not /lobby
    await base.expect(page).toHaveURL(/\/profile/, { timeout: 10_000 });
    await base.expect(page).not.toHaveURL(/\/lobby/);
  });

  // Scenario 4: Direct login without returnUrl → redirect to /lobby (fallback)
  base.test('scenario 4: login without returnUrl redirects to /lobby', async ({ page }) => {
    // Go directly to /login (no returnUrl in state)
    await page.goto('/login');
    await base.expect(page).toHaveURL(/\/login/);

    // Fill login form and submit
    await page.fill('input[type="text"]', registeredUser.username);
    await page.fill('input[type="password"]', registeredUser.password);
    await page.click('button[type="submit"]');

    // After login, should redirect to /lobby (default fallback)
    await base.expect(page).toHaveURL(/\/lobby/, { timeout: 10_000 });
  });

  // Scenario 5: returnUrl works for other protected routes (e.g. /settings)
  base.test('scenario 5: returnUrl works for /settings', async ({ page }) => {
    // Go to /settings while unauthenticated — should redirect to /login
    await page.goto('/settings');
    await base.expect(page).toHaveURL(/\/login/);

    // Fill login form and submit
    await page.fill('input[type="text"]', registeredUser.username);
    await page.fill('input[type="password"]', registeredUser.password);
    await page.click('button[type="submit"]');

    // After login, should redirect to /settings, not /lobby
    await base.expect(page).toHaveURL(/\/settings/, { timeout: 10_000 });
    await base.expect(page).not.toHaveURL(/\/lobby/);
  });

  // Scenario 5b: returnUrl works for /daily (another protected route)
  base.test('scenario 5b: returnUrl works for /daily', async ({ page }) => {
    await page.goto('/daily');
    await base.expect(page).toHaveURL(/\/login/);

    await page.fill('input[type="text"]', registeredUser.username);
    await page.fill('input[type="password"]', registeredUser.password);
    await page.click('button[type="submit"]');

    await base.expect(page).toHaveURL(/\/daily/, { timeout: 10_000 });
    await base.expect(page).not.toHaveURL(/\/lobby/);
  });
});
