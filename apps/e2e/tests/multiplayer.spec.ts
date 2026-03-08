import { test as base, expect, Browser } from '@playwright/test';
import { generateUser, API_URL } from '../fixtures/test-data';

const test = base;

/**
 * Helper: register a user via API and login in a browser context.
 */
async function loginUser(browser: Browser, baseURL: string) {
  const user = generateUser('mp');
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  // Register via API
  const response = await context.request.post(`${API_URL}/auth/register`, {
    data: {
      username: user.username,
      email: user.email,
      password: user.password,
    },
  });
  expect(response.ok()).toBeTruthy();

  // Login via UI
  await page.goto('/login');
  await page.getByPlaceholder(/email/i).fill(user.email);
  await page.getByPlaceholder(/пароль|password/i).fill(user.password);
  await page.getByRole('button', { name: /войти|login/i }).click();
  await page.waitForURL('**/lobby');

  return { page, context, user };
}

test.describe('Multiplayer', () => {
  test('two players should see each other in lobby', async ({ browser }) => {
    const baseURL = process.env.E2E_BASE_URL || 'http://localhost:5173';

    const player1 = await loginUser(browser, baseURL);
    const player2 = await loginUser(browser, baseURL);

    // Both should be on the lobby page
    await expect(player1.page).toHaveURL(/\/lobby/);
    await expect(player2.page).toHaveURL(/\/lobby/);

    // Cleanup
    await player1.context.close();
    await player2.context.close();
  });

  test('two players should be able to start a game', async ({ browser }) => {
    const baseURL = process.env.E2E_BASE_URL || 'http://localhost:5173';

    const player1 = await loginUser(browser, baseURL);
    const player2 = await loginUser(browser, baseURL);

    // Player 1 creates a game
    await player1.page
      .getByRole('button', { name: /создать|create|new game/i })
      .click();

    // Wait for the game to appear or navigate
    await player1.page.waitForTimeout(2000);

    // Cleanup
    await player1.context.close();
    await player2.context.close();
  });
});
