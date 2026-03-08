import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * KS-228: E2E верификация Puzzle Rush Leaderboard
 *
 * Сценарии:
 * 1. Навигация: MainLayout содержит ссылку на Leaderboard, ведущую на корректный роут
 * 2. Роут: страница открывается по /puzzle-rush/leaderboard
 * 3. Компонент: загружает и отображает данные из API /api/puzzle-rush/leaderboard
 * 4. Стили: страница отображается без визуальных дефектов
 * 5. Нет дублирующих/некорректных ссылок /puzzles/rush в навигации
 */

test.describe('KS-228: Puzzle Rush Leaderboard E2E Verification', () => {
  // --- Сценарий 1: Навигация ---

  test('nav header contains link to /puzzle-rush/leaderboard', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/lobby');

    const nav = page.locator('header nav');
    const leaderboardLink = nav.locator('a[href="/puzzle-rush/leaderboard"]');
    await expect(leaderboardLink).toBeVisible();
    await expect(leaderboardLink).toHaveText(/leaderboard|таблица лидеров/i);
  });

  test('nav leaderboard link navigates to correct route', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/lobby');

    const nav = page.locator('header nav');
    await nav.locator('a[href="/puzzle-rush/leaderboard"]').click();

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });

  // --- Сценарий 2: Роут ---

  test('page opens at /puzzle-rush/leaderboard and requires auth', async ({ page }) => {
    await page.goto('/puzzle-rush/leaderboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('authenticated user can access /puzzle-rush/leaderboard', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
    await expect(page.locator('.rush-leaderboard-page h1')).toBeVisible();
  });

  // --- Сценарий 3: Компонент загружает данные из API ---

  test('component fetches /api/puzzle-rush/leaderboard with timeMode param', async ({ authenticatedPage: page }) => {
    const requests: string[] = [];

    await page.route('**/api/puzzle-rush/leaderboard*', (route) => {
      requests.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [
            { userId: 'u1', username: 'Alice', score: 20, createdAt: '2026-01-01' },
          ],
        }),
      });
    });

    await navigateTo(page, '/puzzle-rush/leaderboard');

    // Default mode is '3' — API should be called with timeMode=3
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests[0]).toContain('timeMode=3');

    // Data rendered in table
    const row = page.locator('.rush-lb-row').first();
    await expect(row.locator('.rush-lb-col-rank')).toHaveText('1');
    await expect(row.locator('.rush-lb-col-name')).toHaveText('Alice');
    await expect(row.locator('.rush-lb-col-score')).toHaveText('20');
  });

  test('switching to 5-min mode sends timeMode=5 to API', async ({ authenticatedPage: page }) => {
    const requestedModes: string[] = [];

    await page.route('**/api/puzzle-rush/leaderboard*', (route) => {
      const url = new URL(route.request().url());
      requestedModes.push(url.searchParams.get('timeMode') || '');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [{ userId: 'u1', username: 'Bob', score: 15, createdAt: '2026-01-01' }],
        }),
      });
    });

    await navigateTo(page, '/puzzle-rush/leaderboard');

    // Switch to 5-min mode
    await page.locator('.rush-lb-mode-tabs .tc-btn').nth(1).click();
    await expect(page.locator('.rush-lb-row .rush-lb-col-name').first()).toHaveText('Bob');

    expect(requestedModes).toContain('5');
  });

  // --- Сценарий 4: Стили ---

  test('leaderboard page has correct layout structure and visible elements', async ({ authenticatedPage: page }) => {
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

    // Page container exists
    const container = page.locator('.rush-leaderboard-page');
    await expect(container).toBeVisible();

    // Title visible
    await expect(container.locator('h1')).toBeVisible();

    // Mode tabs visible and styled
    const tabs = container.locator('.rush-lb-mode-tabs .tc-btn');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.first()).toHaveClass(/active/);

    // Table header visible with all columns
    const header = container.locator('.rush-lb-header-row');
    await expect(header).toBeVisible();
    await expect(header.locator('.rush-lb-col-rank')).toBeVisible();
    await expect(header.locator('.rush-lb-col-name')).toBeVisible();
    await expect(header.locator('.rush-lb-col-score')).toBeVisible();

    // Data rows visible
    await expect(container.locator('.rush-lb-row')).toHaveCount(2);

    // Back link visible
    await expect(container.locator('.rush-lb-back-link')).toBeVisible();

    // No overlapping — table container has non-zero dimensions
    const tableBox = await container.locator('.rush-lb-table').boundingBox();
    expect(tableBox).not.toBeNull();
    expect(tableBox!.width).toBeGreaterThan(0);
    expect(tableBox!.height).toBeGreaterThan(0);
  });

  // --- Сценарий 5: Нет дублирующих/некорректных ссылок ---

  test('no duplicate /puzzle-rush links in nav header', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/lobby');

    const nav = page.locator('header nav');

    // Exactly one link to /puzzle-rush (not /puzzle-rush/leaderboard)
    const rushLinks = nav.locator('a[href="/puzzle-rush"]');
    await expect(rushLinks).toHaveCount(1);

    // Exactly one link to /puzzle-rush/leaderboard
    const lbLinks = nav.locator('a[href="/puzzle-rush/leaderboard"]');
    await expect(lbLinks).toHaveCount(1);
  });

  test('no incorrect /puzzles/rush links in nav', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/lobby');

    const nav = page.locator('header nav');

    // There should be no links containing /puzzles/rush (incorrect path)
    const incorrectLinks = nav.locator('a[href*="/puzzles/rush"]');
    await expect(incorrectLinks).toHaveCount(0);
  });

  test('no /puzzles/rush links on leaderboard page itself', async ({ authenticatedPage: page }) => {
    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries: [] }),
      }),
    );

    await navigateTo(page, '/puzzle-rush/leaderboard');

    // No incorrect /puzzles/rush links on the page
    const incorrectLinks = page.locator('a[href*="/puzzles/rush"]');
    await expect(incorrectLinks).toHaveCount(0);
  });
});
