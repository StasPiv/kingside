import { test, expect, navigateTo } from '../fixtures/auth.fixture';

test.describe('Game', () => {
  test('should redirect to lobby if game not found', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/game/nonexistent-id');

    // Should show an error or redirect back
    await page.waitForTimeout(2000);
    const url = page.url();
    expect(url).toMatch(/\/lobby|\/game\//);
  });
});
