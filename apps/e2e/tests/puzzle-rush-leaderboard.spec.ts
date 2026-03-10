import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * E2E tests for Puzzle Rush Leaderboard page.
 * Covers: page load, time mode switching, table structure,
 * current user highlighting, navigation links, i18n, styles.
 */

test.describe('Puzzle Rush Leaderboard', () => {
  test('should open /puzzle-rush/leaderboard page', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
    await expect(page.locator('.rush-leaderboard-page h1')).toBeVisible();
  });

  test('should be accessible without authentication (KS-238)', async ({ page }) => {
    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries: [] }),
      }),
    );

    await page.goto('/puzzle-rush/leaderboard');
    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });

  test('should display time mode tabs with 3 min active by default', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush/leaderboard');

    const tabs = page.locator('.rush-lb-mode-tabs .tc-btn');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.first()).toHaveClass(/active/);
    await expect(tabs.nth(1)).not.toHaveClass(/active/);
  });

  test('should switch between 3 min and 5 min modes', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush/leaderboard');

    const tabs = page.locator('.rush-lb-mode-tabs .tc-btn');

    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveClass(/active/);
    await expect(tabs.first()).not.toHaveClass(/active/);

    await tabs.first().click();
    await expect(tabs.first()).toHaveClass(/active/);
    await expect(tabs.nth(1)).not.toHaveClass(/active/);
  });

  test('should show table header with rank, player, score columns', async ({ authenticatedPage: page }) => {
    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [
            { userId: 'u1', username: 'player1', score: 25, createdAt: '2026-01-01' },
          ],
        }),
      }),
    );

    await navigateTo(page, '/puzzle-rush/leaderboard');

    const header = page.locator('.rush-lb-header-row');
    await expect(header).toBeVisible();
    await expect(header.locator('.rush-lb-col-rank')).toHaveText('#');
    await expect(header.locator('.rush-lb-col-name')).toBeVisible();
    await expect(header.locator('.rush-lb-col-score')).toBeVisible();
  });

  test('should display leaderboard entries with position, name, score', async ({ authenticatedPage: page }) => {
    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [
            { userId: 'u1', username: 'GrandMaster1', score: 30, createdAt: '2026-01-01' },
            { userId: 'u2', username: 'ChessKing', score: 25, createdAt: '2026-01-02' },
            { userId: 'u3', username: 'Rookie', score: 10, createdAt: '2026-01-03' },
          ],
        }),
      }),
    );

    await navigateTo(page, '/puzzle-rush/leaderboard');

    const rows = page.locator('.rush-lb-row');
    await expect(rows).toHaveCount(3);

    const firstRow = rows.first();
    await expect(firstRow.locator('.rush-lb-col-rank')).toHaveText('1');
    await expect(firstRow.locator('.rush-lb-col-name')).toHaveText('GrandMaster1');
    await expect(firstRow.locator('.rush-lb-col-score')).toHaveText('30');

    const lastRow = rows.nth(2);
    await expect(lastRow.locator('.rush-lb-col-rank')).toHaveText('3');
    await expect(lastRow.locator('.rush-lb-col-name')).toHaveText('Rookie');
    await expect(lastRow.locator('.rush-lb-col-score')).toHaveText('10');
  });

  test('should show empty state when no entries', async ({ authenticatedPage: page }) => {
    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries: [] }),
      }),
    );

    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page.locator('.rush-lb-empty')).toBeVisible();
    await expect(page.locator('.rush-lb-table')).not.toBeVisible();
  });

  test('should show error state on API failure', async ({ authenticatedPage: page }) => {
    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    );

    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page.locator('.error')).toBeVisible();
  });

  test('should highlight current user row', async ({ authenticatedPage: page }) => {
    // Get current user id from the auth context
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

  test('should update data when switching time modes', async ({ authenticatedPage: page }) => {
    let requestedMode = '';

    await page.route('**/api/puzzle-rush/leaderboard*', (route) => {
      const url = new URL(route.request().url());
      requestedMode = url.searchParams.get('timeMode') || '3';

      const entries = requestedMode === '5'
        ? [{ userId: 'u1', username: 'FiveMinKing', score: 40, createdAt: '2026-01-01' }]
        : [{ userId: 'u2', username: 'ThreeMinKing', score: 35, createdAt: '2026-01-01' }];

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries }),
      });
    });

    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page.locator('.rush-lb-row .rush-lb-col-name').first()).toHaveText('ThreeMinKing');

    await page.locator('.rush-lb-mode-tabs .tc-btn').nth(1).click();
    await expect(page.locator('.rush-lb-row .rush-lb-col-name').first()).toHaveText('FiveMinKing');
  });

  test('should have back-to-rush link navigating to /puzzle-rush', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush/leaderboard');

    const backLink = page.locator('.rush-lb-back-link');
    await expect(backLink).toBeVisible();
    await backLink.click();

    await expect(page).toHaveURL(/\/puzzle-rush$/);
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();
  });

  test('should navigate to leaderboard from puzzle rush start screen', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    const leaderboardLink = page.locator('.rush-leaderboard-link');
    await expect(leaderboardLink).toBeVisible();
    await leaderboardLink.click();

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });

  test('should display English translations by default', async ({ authenticatedPage: page }) => {
    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [{ userId: 'u1', username: 'test', score: 10, createdAt: '2026-01-01' }],
        }),
      }),
    );

    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page.locator('.rush-leaderboard-page h1')).toHaveText('Puzzle Rush Leaderboard');
    await expect(page.locator('.rush-lb-back-link')).toHaveText('Back to Puzzle Rush');

    const tabs = page.locator('.rush-lb-mode-tabs .tc-btn');
    await expect(tabs.first()).toHaveText('3 Minutes');
    await expect(tabs.nth(1)).toHaveText('5 Minutes');
  });

  test('should display Russian translations when language is ru', async ({ authenticatedPage: page }) => {
    // Switch language to Russian via localStorage
    await page.evaluate(() => {
      localStorage.setItem('i18nextLng', 'ru');
    });

    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [{ userId: 'u1', username: 'test', score: 10, createdAt: '2026-01-01' }],
        }),
      }),
    );

    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page.locator('.rush-leaderboard-page h1')).toHaveText('Таблица лидеров Puzzle Rush');
    await expect(page.locator('.rush-lb-back-link')).toHaveText('Назад к Puzzle Rush');
  });

  test('should show loading state while fetching data', async ({ authenticatedPage: page }) => {
    await page.route('**/api/puzzle-rush/leaderboard*', async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries: [] }),
      });
    });

    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page.locator('.loading')).toBeVisible();
  });

  test('should render correctly on mobile viewport', async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [
            { userId: 'u1', username: 'Player1', score: 30, createdAt: '2026-01-01' },
            { userId: 'u2', username: 'Player2', score: 20, createdAt: '2026-01-02' },
          ],
        }),
      }),
    );

    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
    await expect(page.locator('.rush-lb-mode-tabs')).toBeVisible();
    await expect(page.locator('.rush-lb-table')).toBeVisible();
    await expect(page.locator('.rush-lb-back-link')).toBeVisible();

    const rows = page.locator('.rush-lb-row');
    await expect(rows).toHaveCount(2);

    // Verify no horizontal overflow
    const pageWidth = await page.locator('.rush-leaderboard-page').evaluate(
      (el) => el.scrollWidth <= el.clientWidth,
    );
    expect(pageWidth).toBe(true);
  });
});
