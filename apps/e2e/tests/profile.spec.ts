import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * E2E tests for User Profile page.
 * Covers: page load, username & registration date, ratings display,
 * recent games list, header link navigation, auth guard, CSS styles.
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

const mockGames = [
  {
    id: 'g1',
    white: { id: 'user-1', username: 'TestPlayer' },
    black: { id: 'user-2', username: 'Opponent1' },
    result: '1-0',
    timeControl: '5+3',
    createdAt: '2026-03-07T18:00:00Z',
  },
  {
    id: 'g2',
    white: { id: 'user-3', username: 'Opponent2' },
    black: { id: 'user-1', username: 'TestPlayer' },
    result: '0-1',
    timeControl: '3+0',
    createdAt: '2026-03-06T15:00:00Z',
  },
  {
    id: 'g3',
    white: { id: 'user-1', username: 'TestPlayer' },
    black: { id: 'user-4', username: 'Opponent3' },
    result: '1/2-1/2',
    timeControl: '10+5',
    createdAt: '2026-03-05T12:00:00Z',
  },
];

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
        body: JSON.stringify(
          mockGames.map((g) => ({
            ...g,
            white: g.white.id === 'user-1' ? { ...g.white, id: userId } : g.white,
            black: g.black.id === 'user-1' ? { ...g.black, id: userId } : g.black,
          })),
        ),
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

async function setLocale(page: import('@playwright/test').Page, locale: 'en' | 'ru') {
  await page.evaluate((loc) => {
    localStorage.setItem('locale', loc);
  }, locale);
}

test.describe('Profile Page', () => {
  test('should open /profile page and display username and registration date', async ({
    authenticatedPage: page,
  }) => {
    const userId = await getUserId(page);
    await setupProfileMocks(page, userId);
    await setLocale(page, 'en');
    await navigateTo(page, '/profile');

    await expect(page.locator('.profile-page')).toBeVisible();
    await expect(page.locator('.profile-header h1')).toHaveText('TestPlayer');
    await expect(page.locator('.profile-member-since')).toBeVisible();
    await expect(page.locator('.profile-member-since')).toContainText('2025');
  });

  test('should display all four rating categories', async ({ authenticatedPage: page }) => {
    const userId = await getUserId(page);
    await setupProfileMocks(page, userId);
    await setLocale(page, 'en');
    await navigateTo(page, '/profile');

    const cards = page.locator('.rating-card');
    await expect(cards).toHaveCount(4);

    await expect(cards.nth(0).locator('.rating-value')).toHaveText('1200');
    await expect(cards.nth(1).locator('.rating-value')).toHaveText('1350');
    await expect(cards.nth(2).locator('.rating-value')).toHaveText('1500');
    await expect(cards.nth(3).locator('.rating-value')).toHaveText('1600');

    await expect(cards.nth(0).locator('.rating-label')).toHaveText('Bullet');
    await expect(cards.nth(1).locator('.rating-label')).toHaveText('Blitz');
    await expect(cards.nth(2).locator('.rating-label')).toHaveText('Rapid');
    await expect(cards.nth(3).locator('.rating-label')).toHaveText('Classical');
  });

  test('should display recent games with opponent, time control, result', async ({
    authenticatedPage: page,
  }) => {
    const userId = await getUserId(page);
    await setupProfileMocks(page, userId);
    await setLocale(page, 'en');
    await navigateTo(page, '/profile');

    await expect(page.locator('.profile-games h2')).toHaveText('Recent games');

    const records = page.locator('.game-record');
    await expect(records).toHaveCount(3);

    const first = records.first();
    await expect(first.locator('.game-opponent')).toHaveText('vs Opponent1');
    await expect(first.locator('.game-tc')).toHaveText('5+3');
    await expect(first.locator('.game-result-badge')).toHaveText('1-0');
    await expect(first.locator('.game-date')).toBeVisible();
  });

  test('should navigate to /profile when clicking username in header', async ({
    authenticatedPage: page,
  }) => {
    const userId = await getUserId(page);
    await setupProfileMocks(page, userId);

    await page.locator('.nav-user').click();

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

  test('should redirect unauthenticated user to /login', async ({ page }) => {
    await page.goto('/profile');
    await expect(page).toHaveURL(/\/login/);
  });

  test('should show error state on API failure', async ({ authenticatedPage: page }) => {
    const userId = await getUserId(page);

    await page.route(`**/api/users/${userId}`, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    );
    await page.route(`**/api/users/${userId}/games*`, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '[]' }),
    );

    await navigateTo(page, '/profile');

    await expect(page.locator('.error')).toBeVisible();
  });

  test('should show loading state while fetching data', async ({ authenticatedPage: page }) => {
    const userId = await getUserId(page);

    await page.route(`**/api/users/${userId}`, async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockProfile),
      });
    });
    await page.route(`**/api/users/${userId}/games*`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );

    await navigateTo(page, '/profile');

    await expect(page.locator('.loading')).toBeVisible();
  });

  test('should not show games section when no games exist', async ({
    authenticatedPage: page,
  }) => {
    const userId = await getUserId(page);

    await page.route(`**/api/users/${userId}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...mockProfile, id: userId }),
      }),
    );
    await page.route(`**/api/users/${userId}/games*`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    );

    await navigateTo(page, '/profile');

    await expect(page.locator('.profile-page')).toBeVisible();
    await expect(page.locator('.profile-games')).not.toBeVisible();
  });

  test('should have correct CSS layout for profile page', async ({
    authenticatedPage: page,
  }) => {
    const userId = await getUserId(page);
    await setupProfileMocks(page, userId);
    await navigateTo(page, '/profile');

    const profilePage = page.locator('.profile-page');
    await expect(profilePage).toBeVisible();

    const maxWidth = await profilePage.evaluate(
      (el) => getComputedStyle(el).maxWidth,
    );
    expect(maxWidth).toBe('640px');

    await expect(page.locator('.ratings-grid')).toBeVisible();
    await expect(page.locator('.games-list')).toBeVisible();
  });
});
