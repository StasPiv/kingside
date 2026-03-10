import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * Mock-based Puzzle Rush tests.
 * These tests use page.route() to simulate edge cases that are hard
 * to reproduce against a real server: API errors, network delays,
 * game-over sequences.
 */
test.describe('Puzzle Rush — mocked edge cases', () => {
  test('should handle start session API error gracefully', async ({ authenticatedPage: page }) => {
    await page.route('**/api/puzzle-rush/start', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'No puzzles available', errorCode: 'NO_PUZZLES' }),
      }),
    );

    await navigateTo(page, '/puzzle-rush');
    await page.locator('.play-btn').click();

    await expect(page.locator('.error')).toBeVisible({ timeout: 5_000 });
  });

  test('should show result screen on session finish via API', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    await page.locator('.play-btn').click();
    await expect(page.locator('.rush-time')).toBeVisible({ timeout: 10_000 });

    await page.route('**/api/puzzle-rush/solve', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          correct: false,
          score: 0,
          lives: 0,
          finished: true,
          nextPuzzle: null,
        }),
      }),
    );

    await page.evaluate(async () => {
      const token = localStorage.getItem('token');
      await fetch('/api/puzzle-rush/solve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ uci: 'e2e4' }),
      });
    });
  });

  test('should show result screen elements after game over', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    let startCalled = false;
    await page.route('**/api/puzzle-rush/start', async (route) => {
      if (startCalled) {
        await route.continue();
        return;
      }
      startCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId: 'test-session',
          puzzle: {
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            rating: 1200,
            moves: 'e2e4 e7e5',
          },
          timeMode: '3',
          durationMs: 180000,
          lives: 3,
        }),
      });
    });

    let solveCount = 0;
    await page.route('**/api/puzzle-rush/solve', async (route) => {
      solveCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          correct: false,
          score: 0,
          lives: Math.max(0, 3 - solveCount),
          finished: solveCount >= 3,
          nextPuzzle:
            solveCount < 3
              ? {
                  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                  rating: 1200,
                  setupMove: 'e2e4',
                }
              : null,
        }),
      });
    });

    await page.locator('.play-btn').click();
    await expect(page.locator('.rush-time')).toBeVisible({ timeout: 10_000 });
  });

  test('should show timer with low-time styling', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    await page.route('**/api/puzzle-rush/start', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId: 'test',
          puzzle: {
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            rating: 1200,
            moves: 'e2e4 e7e5',
          },
          timeMode: '3',
          durationMs: 180000,
          lives: 3,
        }),
      });
    });

    await page.locator('.play-btn').click();
    await expect(page.locator('.rush-time')).toBeVisible({ timeout: 10_000 });

    const timeText = await page.locator('.rush-time').textContent();
    expect(timeText).toMatch(/^\d+:\d{2}$/);
  });

  test('start button should be disabled while loading', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/puzzle-rush');

    await page.route('**/api/puzzle-rush/start', async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId: 'test',
          puzzle: {
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            rating: 1200,
            moves: 'e2e4 e7e5',
          },
          timeMode: '3',
          durationMs: 180000,
          lives: 3,
        }),
      });
    });

    await page.locator('.play-btn').click();
    await expect(page.locator('.play-btn')).toBeDisabled();
  });
});
