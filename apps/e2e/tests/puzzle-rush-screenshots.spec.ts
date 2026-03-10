import { test, expect, navigateTo } from '../fixtures/auth.fixture';
import path from 'path';

const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots');

/**
 * KS-237: Capture Puzzle Rush screenshots for Jira (KS-118).
 *
 * Screenshots:
 * 1. Start screen (time mode selection)
 * 2. Game screen (board, timer, lives, score)
 * 3. Leaderboard page /puzzle-rush/leaderboard
 * 4. Puzzle Rush link in navigation
 * 5. Profile page /profile with records
 */
test.describe('Puzzle Rush Screenshots', () => {
  test('1 - start screen with time selection', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, '01-puzzle-rush-start.png'),
      fullPage: true,
    });
  });

  test('2 - game screen with board, timer, lives, score', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');
    await page.locator('.play-btn').click();

    await expect(page.locator('.rush-time')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.rush-solved')).toBeVisible();
    await expect(page.locator('.rush-lives')).toBeVisible();
    await expect(page.locator('.board-container')).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, '02-puzzle-rush-game.png'),
      fullPage: true,
    });
  });

  test('3 - leaderboard page', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await page.waitForLoadState('networkidle');

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, '03-puzzle-rush-leaderboard.png'),
      fullPage: true,
    });
  });

  test('4 - puzzle rush link in navigation', async ({ authenticatedPage: page }) => {
    const navLink = page.getByRole('link', { name: /puzzle rush/i }).first();
    await expect(navLink).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, '04-puzzle-rush-nav-link.png'),
      fullPage: true,
    });
  });

  test('5 - profile page with records', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/profile');

    await page.waitForLoadState('networkidle');

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, '05-profile-records.png'),
      fullPage: true,
    });
  });
});
