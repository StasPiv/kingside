import { test, expect } from '../fixtures/auth.fixture';

test.describe('Puzzle Rush', () => {
  test('should display start screen with time mode selection', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/puzzle-rush');

    // Title visible
    await expect(
      page.getByRole('heading', { name: /puzzle rush/i }),
    ).toBeVisible();

    // Time mode buttons
    await expect(
      page.getByRole('button', { name: /3 minutes|3 минуты/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /5 minutes|5 минут/i }),
    ).toBeVisible();

    // Start button
    await expect(
      page.getByRole('button', { name: /start|старт/i }),
    ).toBeVisible();
  });

  test('should switch time mode when clicking buttons', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/puzzle-rush');

    const btn3 = page.getByRole('button', { name: /3 minutes|3 минуты/i });
    const btn5 = page.getByRole('button', { name: /5 minutes|5 минут/i });

    // 3 min is default active
    await expect(btn3).toHaveClass(/active/);

    // Click 5 minutes
    await btn5.click();
    await expect(btn5).toHaveClass(/active/);
    await expect(btn3).not.toHaveClass(/active/);

    // Click back to 3 minutes
    await btn3.click();
    await expect(btn3).toHaveClass(/active/);
  });

  test('should start a session and show playing screen', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/puzzle-rush');
    await page.getByRole('button', { name: /start|старт/i }).click();

    // Should show playing screen elements
    // Timer
    await expect(page.locator('.rush-time')).toBeVisible({ timeout: 10000 });

    // Score counter
    await expect(page.locator('.rush-solved')).toBeVisible();

    // Lives display
    await expect(page.locator('.rush-lives')).toBeVisible();

    // Chess board should be rendered
    await expect(page.locator('.board-container')).toBeVisible();

    // "Find the best move" hint
    await expect(
      page.getByText(/find the best move|найдите лучший ход/i),
    ).toBeVisible();
  });

  test('timer should count down during session', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/puzzle-rush');
    await page.getByRole('button', { name: /start|старт/i }).click();

    // Wait for timer to appear
    const timer = page.locator('.rush-time');
    await expect(timer).toBeVisible({ timeout: 10000 });

    // Get initial time text
    const initialTime = await timer.textContent();

    // Wait 2 seconds
    await page.waitForTimeout(2000);

    // Timer should have decreased
    const laterTime = await timer.textContent();
    expect(laterTime).not.toBe(initialTime);
  });

  test('should show 3 lives at start', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/puzzle-rush');
    await page.getByRole('button', { name: /start|старт/i }).click();

    const lives = page.locator('.rush-lives');
    await expect(lives).toBeVisible({ timeout: 10000 });

    // Should contain 3 heart emojis (❤️)
    const livesText = await lives.textContent();
    const heartCount = (livesText?.match(/❤️/g) || []).length;
    expect(heartCount).toBe(3);
  });

  test('should show score starting at 0', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/puzzle-rush');
    await page.getByRole('button', { name: /start|старт/i }).click();

    const score = page.locator('.rush-solved');
    await expect(score).toBeVisible({ timeout: 10000 });
    await expect(score).toHaveText('0');
  });

  test('should show chessboard with pieces', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/puzzle-rush');
    await page.getByRole('button', { name: /start|старт/i }).click();

    // Board container should appear
    await expect(page.locator('.board-container')).toBeVisible({
      timeout: 10000,
    });

    // There should be chess pieces on the board (rendered by react-chessboard)
    // react-chessboard renders pieces as data-piece attributes or img elements
    const boardArea = page.locator('.board-container');
    await expect(boardArea).not.toBeEmpty();
  });

  test('should redirect unauthenticated user to login', async ({ page }) => {
    await page.goto('/puzzle-rush');
    await expect(page).toHaveURL(/\/login/);
  });

  test('start screen should show description text', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/puzzle-rush');

    await expect(
      page.locator('.puzzle-rush-description'),
    ).toBeVisible();
  });

  test('should handle start with 5-minute mode', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/puzzle-rush');

    // Select 5 minutes
    await page.getByRole('button', { name: /5 minutes|5 минут/i }).click();
    await page.getByRole('button', { name: /start|старт/i }).click();

    // Timer should show ~5:00
    const timer = page.locator('.rush-time');
    await expect(timer).toBeVisible({ timeout: 10000 });
    const timeText = await timer.textContent();
    // Should start at 5:00 or 4:59
    expect(timeText).toMatch(/^[45]:\d{2}$/);
  });

  test('navigation should have puzzle rush link', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/lobby');

    const link = page.getByRole('link', { name: /puzzle rush/i });
    await expect(link).toBeVisible();

    await link.click();
    await expect(page).toHaveURL(/\/puzzle-rush/);
  });
});
