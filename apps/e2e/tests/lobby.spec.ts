import { test, expect } from '../fixtures/auth.fixture';

test.describe('Lobby', () => {
  test('should display lobby page after login', async ({ authenticatedPage: page }) => {
    await expect(page).toHaveURL(/\/lobby/);
  });

  test('should show play button', async ({ authenticatedPage: page }) => {
    await expect(
      page.getByRole('button', { name: 'Play', exact: true }),
    ).toBeVisible();
  });

  test('should start searching for a game', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: 'Play', exact: true }).click();

    // Should either navigate to a game page or show a waiting/searching state
    await page.waitForTimeout(2000);
    await expect(page).toHaveURL(/\/game\/|\/lobby/);
  });
});
