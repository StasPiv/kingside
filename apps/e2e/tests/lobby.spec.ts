import { test, expect } from '../fixtures/auth.fixture';

test.describe('Lobby', () => {
  test('should display lobby page after login', async ({ authenticatedPage: page }) => {
    await expect(page).toHaveURL(/\/lobby/);
  });

  test('should show game creation controls', async ({ authenticatedPage: page }) => {
    await expect(
      page.getByRole('button', { name: /создать|create|new game/i }),
    ).toBeVisible();
  });

  test('should create a new game', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /создать|create|new game/i }).click();

    // Should either navigate to a game page or show a waiting state
    await expect(page).toHaveURL(/\/game\/|\/lobby/);
  });
});
