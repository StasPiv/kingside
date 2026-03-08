import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * E2E tests for User Profile page.
 * Covers: profile data display, ratings, recent games,
 * header nickname link, empty games state, unauthenticated access.
 */

test.describe('Profile Page', () => {
  test('should open /profile and display profile data', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/profile');

    await expect(page.locator('.profile-page')).toBeVisible();
    await expect(page.locator('.profile-header h1')).toBeVisible();
    await expect(page.locator('.profile-member-since')).toBeVisible();
  });

  test('should display all four rating categories', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/profile');

    const ratingCards = page.locator('.rating-card');
    await expect(ratingCards).toHaveCount(4);

    await expect(page.locator('.rating-label').nth(0)).toHaveText('Пуля');
    await expect(page.locator('.rating-label').nth(1)).toHaveText('Блиц');
    await expect(page.locator('.rating-label').nth(2)).toHaveText('Рапид');
    await expect(page.locator('.rating-label').nth(3)).toHaveText('Классика');

    // Each rating should have a numeric value
    for (let i = 0; i < 4; i++) {
      const value = await page.locator('.rating-value').nth(i).textContent();
      expect(value).toBeTruthy();
      expect(Number(value)).not.toBeNaN();
    }
  });

  test('should display recent games from /api/users/:id/games', async ({ authenticatedPage: page }) => {
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

    await page.route(`**/api/users/${userInfo?.id}/games*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'g1',
            white: { id: userInfo?.id ?? 'me', username: userInfo?.username ?? 'me' },
            black: { id: 'opp1', username: 'Opponent1' },
            result: '1-0',
            timeControl: '5+0',
            createdAt: '2026-03-01T12:00:00Z',
          },
          {
            id: 'g2',
            white: { id: 'opp2', username: 'Opponent2' },
            black: { id: userInfo?.id ?? 'me', username: userInfo?.username ?? 'me' },
            result: '0-1',
            timeControl: '3+0',
            createdAt: '2026-03-02T12:00:00Z',
          },
        ]),
      }),
    );

    await navigateTo(page, '/profile');

    await expect(page.locator('.profile-games')).toBeVisible();
    await expect(page.locator('.profile-games h2')).toHaveText('Последние партии');

    const gameRecords = page.locator('.game-record');
    await expect(gameRecords).toHaveCount(2);

    await expect(gameRecords.first().locator('.game-opponent')).toHaveText('vs Opponent1');
    await expect(gameRecords.first().locator('.game-tc')).toHaveText('5+0');
    await expect(gameRecords.first().locator('.game-result-badge')).toHaveText('1-0');

    await expect(gameRecords.nth(1).locator('.game-opponent')).toHaveText('vs Opponent2');
  });

  test('should fetch correct data from /api/users/:id', async ({ authenticatedPage: page }) => {
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

    await page.route(`**/api/users/${userInfo?.id}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: userInfo?.id,
          username: 'TestPlayer',
          ratingBullet: 1200,
          ratingBlitz: 1350,
          ratingRapid: 1500,
          ratingClassical: 1600,
          createdAt: '2025-06-15T10:00:00Z',
          lastSeenAt: '2026-03-08T10:00:00Z',
        }),
      }),
    );

    await page.route(`**/api/users/${userInfo?.id}/games*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      }),
    );

    await navigateTo(page, '/profile');

    await expect(page.locator('.profile-header h1')).toHaveText('TestPlayer');
    await expect(page.locator('.rating-value').nth(0)).toHaveText('1200');
    await expect(page.locator('.rating-value').nth(1)).toHaveText('1350');
    await expect(page.locator('.rating-value').nth(2)).toHaveText('1500');
    await expect(page.locator('.rating-value').nth(3)).toHaveText('1600');
  });

  test('should navigate to /profile when clicking username in header', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/lobby');

    const userLink = page.locator('a.nav-user');
    await expect(userLink).toBeVisible();
    await userLink.click();

    await expect(page).toHaveURL(/\/profile/);
    await expect(page.locator('.profile-page')).toBeVisible();
  });

  test('should render username in header as a Link, not a span', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/lobby');

    const navUser = page.locator('.nav-user');
    await expect(navUser).toBeVisible();

    const tagName = await navUser.evaluate((el) => el.tagName.toLowerCase());
    expect(tagName).toBe('a');

    const href = await navUser.getAttribute('href');
    expect(href).toBe('/profile');
  });

  test('should not show games section when user has no games', async ({ authenticatedPage: page }) => {
    const userInfo = await page.evaluate(() => {
      const token = localStorage.getItem('token');
      if (!token) return null;
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        return { id: payload.sub || payload.id };
      } catch {
        return null;
      }
    });

    await page.route(`**/api/users/${userInfo?.id}/games*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      }),
    );

    await navigateTo(page, '/profile');

    await expect(page.locator('.profile-page')).toBeVisible();
    await expect(page.locator('.profile-games')).not.toBeVisible();
  });

  test('should redirect unauthenticated user to login', async ({ page }) => {
    await page.goto('/profile');
    await expect(page).toHaveURL(/\/login/);
  });
});
