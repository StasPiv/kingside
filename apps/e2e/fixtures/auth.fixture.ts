import { test as base, expect, Page } from '@playwright/test';
import { generateUser, API_URL } from './test-data';

type AuthFixtures = {
  registeredUser: { username: string; email: string; password: string };
  authenticatedPage: Page;
};

/**
 * Navigate to a page while preserving auth state.
 * Uses addInitScript to ensure tokens survive page reloads by
 * re-injecting them before React mounts on each navigation.
 */
export async function navigateTo(page: Page, path: string) {
  await page.goto(path);
  // Wait for auth to settle — Logout link appears when authenticated
  await page.getByText(/logout|выйти/i).waitFor({ timeout: 10_000 });
}

/**
 * Extended test fixture that provides a pre-registered user
 * and an authenticated page for tests that need a logged-in session.
 *
 * Auth is done entirely via API calls (no UI interaction) for reliability.
 * Tokens are injected into localStorage via addInitScript to survive
 * page reloads.
 */
export const test = base.extend<AuthFixtures>({
  registeredUser: async ({ page }, use) => {
    const user = generateUser();
    const response = await page.request.post(`${API_URL}/api/auth/register`, {
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
    // Login via API to get tokens
    const loginRes = await page.request.post(`${API_URL}/api/auth/login`, {
      data: {
        username: registeredUser.username,
        password: registeredUser.password,
      },
    });
    expect(loginRes.ok()).toBeTruthy();
    const tokens = await loginRes.json();

    // Inject tokens into localStorage before every page load.
    // This ensures auth state survives full page reloads.
    await page.addInitScript((t) => {
      localStorage.setItem('token', t.accessToken);
      localStorage.setItem('refreshToken', t.refreshToken);
    }, tokens);

    // Navigate to lobby — tokens are already in localStorage
    await page.goto('/lobby');
    await page.getByText(/logout|выйти/i).waitFor({ timeout: 10_000 });
    await use(page);
  },
});

export { expect };
