import { test, expect } from '@playwright/test';
import { generateUser } from '../fixtures/test-data';

test.describe('Authentication', () => {
  test('should show login page for unauthenticated users', async ({ page }) => {
    await page.goto('/lobby');
    await expect(page).toHaveURL(/\/login/);
  });

  test('should register a new user', async ({ page }) => {
    const user = generateUser();
    await page.goto('/register');

    await page.getByPlaceholder(/имя пользователя|username/i).fill(user.username);
    await page.getByPlaceholder(/email/i).fill(user.email);
    await page.getByPlaceholder(/^(пароль|password)$/i).fill(user.password);
    await page.getByPlaceholder(/confirm/i).fill(user.password);
    await page.getByRole('button', { name: /регистрация|register/i }).click();

    await expect(page).toHaveURL(/\/lobby/);
  });

  test('should login with valid credentials', async ({ page }) => {
    const user = generateUser();

    // Register first
    await page.goto('/register');
    await page.getByPlaceholder(/имя пользователя|username/i).fill(user.username);
    await page.getByPlaceholder(/email/i).fill(user.email);
    await page.getByPlaceholder(/^(пароль|password)$/i).fill(user.password);
    await page.getByPlaceholder(/confirm/i).fill(user.password);
    await page.getByRole('button', { name: /регистрация|register/i }).click();
    await expect(page).toHaveURL(/\/lobby/);

    // Logout (clear storage) and login
    await page.evaluate(() => localStorage.clear());
    await page.goto('/login');
    await page.getByPlaceholder(/имя пользователя|username/i).fill(user.username);
    await page.getByPlaceholder(/пароль|password/i).fill(user.password);
    await page.getByRole('button', { name: /войти|sign in|login/i }).click();

    await expect(page).toHaveURL(/\/lobby/);
  });

  test('should reject invalid credentials', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder(/имя пользователя|username/i).fill('nonexistent');
    await page.getByPlaceholder(/пароль|password/i).fill('WrongPassword1!');
    await page.getByRole('button', { name: /войти|sign in|login/i }).click();

    await expect(page).not.toHaveURL(/\/lobby/);
  });

  test('should navigate between login and register pages', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: /регистрация|register|sign up/i }).first().click();
    await expect(page).toHaveURL(/\/register/);

    await page.getByRole('link', { name: /войти|login|sign in/i }).first().click();
    await expect(page).toHaveURL(/\/login/);
  });
});
