import { test as base, expect, Page } from '@playwright/test';
import { generateUser, API_URL } from './test-data';

type AuthFixtures = {
  registeredUser: { username: string; email: string; password: string };
  authenticatedPage: Page;
};

/**
 * Extended test fixture that provides a pre-registered user
 * and an authenticated page for tests that need a logged-in session.
 */
export const test = base.extend<AuthFixtures>({
  registeredUser: async ({ request }, use) => {
    const user = generateUser();
    const response = await request.post(`${API_URL}/auth/register`, {
      data: {
        username: user.username,
        email: user.email,
        password: user.password,
      },
    });
    expect(response.ok()).toBeTruthy();
    await use(user);
  },

  authenticatedPage: async ({ page, registeredUser }, use) => {
    await page.goto('/login');
    await page.getByPlaceholder(/email/i).fill(registeredUser.email);
    await page.getByPlaceholder(/пароль|password/i).fill(registeredUser.password);
    await page.getByRole('button', { name: /войти|login/i }).click();
    await page.waitForURL('**/lobby');
    await use(page);
  },
});

export { expect };
