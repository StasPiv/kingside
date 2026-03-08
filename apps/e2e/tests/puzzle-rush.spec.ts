import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * Integration Puzzle Rush tests.
 * These tests run against the real dev-server (API + DB).
 * No page.route() mocks — all requests hit the real backend.
 */
test.describe('Puzzle Rush', () => {
  test('should display start screen with time selection', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    await expect(page.locator('.puzzle-rush-page h1')).toBeVisible();

    const timeControls = page.locator('.puzzle-rush-time-select .tc-btn');
    await expect(timeControls).toHaveCount(2);
    await expect(timeControls.first()).toHaveClass(/active/);
    await expect(page.locator('.play-btn')).toBeVisible();
  });

  test('should allow switching time mode', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    const timeControls = page.locator('.puzzle-rush-time-select .tc-btn');

    await timeControls.nth(1).click();
    await expect(timeControls.nth(1)).toHaveClass(/active/);
    await expect(timeControls.first()).not.toHaveClass(/active/);

    await timeControls.first().click();
    await expect(timeControls.first()).toHaveClass(/active/);
    await expect(timeControls.nth(1)).not.toHaveClass(/active/);
  });

  test('should start a puzzle rush session', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    await page.locator('.play-btn').click();

    await expect(page.locator('.rush-time')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.rush-solved')).toBeVisible();
    await expect(page.locator('.rush-lives')).toBeVisible();

    await expect(page.locator('.puzzle-rush-board')).toBeVisible();
    await expect(page.locator('.board-container')).toBeVisible();
  });

  test('should display timer counting down', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');
    await page.locator('.play-btn').click();

    await expect(page.locator('.rush-time')).toBeVisible({ timeout: 10_000 });

    const initialTime = await page.locator('.rush-time').textContent();
    expect(initialTime).toBeTruthy();

    await page.waitForTimeout(2000);
    const updatedTime = await page.locator('.rush-time').textContent();
    expect(updatedTime).not.toBe(initialTime);
  });

  test('should show initial score 0 and 3 lives', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');
    await page.locator('.play-btn').click();

    await expect(page.locator('.rush-time')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('.rush-solved')).toHaveText('0');

    const livesText = await page.locator('.rush-lives').textContent();
    expect(livesText).toBeTruthy();
    const heartCount = (livesText!.match(/\u2764/g) || []).length;
    expect(heartCount).toBe(3);
  });

  test('should show hint text during play', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');
    await page.locator('.play-btn').click();

    await expect(page.locator('.rush-time')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.puzzle-hint')).toBeVisible();
  });

  test('should show chessboard with pieces', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');
    await page.locator('.play-btn').click();

    await expect(page.locator('.board-container')).toBeVisible({
      timeout: 10000,
    });

    const boardArea = page.locator('.board-container');
    await expect(boardArea).not.toBeEmpty();
  });

  test('should navigate to puzzle rush from nav link', async ({ authenticatedPage: page }) => {
    await page.getByRole('link', { name: /puzzle rush/i }).first().click();
    await expect(page).toHaveURL(/\/puzzle-rush/);
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();
  });

  test('should require authentication', async ({ page }) => {
    await page.goto('/puzzle-rush');
    await expect(page).toHaveURL(/\/login/);
  });

  test('should display description text on start screen', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');
    await expect(page.locator('.puzzle-rush-description')).toBeVisible();
  });

  test('should handle start with 5-minute mode', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    const timeControls = page.locator('.puzzle-rush-time-select .tc-btn');
    await timeControls.nth(1).click();
    await page.locator('.play-btn').click();

    const timer = page.locator('.rush-time');
    await expect(timer).toBeVisible({ timeout: 10000 });
    const timeText = await timer.textContent();
    expect(timeText).toMatch(/^[45]:\d{2}$/);
  });
});
