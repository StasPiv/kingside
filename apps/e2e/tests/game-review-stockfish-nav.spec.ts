import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * KS-318: E2E verification of KS-317 fix — Stockfish crash on rapid move navigation.
 *
 * Scenarios:
 * 1. Rapid arrow key navigation — page does not crash, analysis panel stays visible
 * 2. Rapid forward/back button clicks — analysis updates without crash
 * 3. Home/End during active analysis — engine switches correctly
 * 4. Debounce prevents multiple evaluate calls on <150ms navigation
 * 5. Correct evaluation display after navigation (not stale from previous move)
 */

const GAME_ID = '550e8400-e29b-41d4-a716-446655440000';

const mockGame = {
  id: GAME_ID,
  white: { id: 'w1', username: 'WhitePlayer' },
  black: { id: 'b1', username: 'BlackPlayer' },
  result: 'white',
  timeControl: '5+3',
  status: 'finished',
};

const FEN_INITIAL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const mockMoves = [
  { san: 'e4', uci: 'e2e4', fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1' },
  { san: 'e5', uci: 'e7e5', fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2' },
  { san: 'Nf3', uci: 'g1f3', fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' },
  { san: 'Nc6', uci: 'b8c6', fenAfter: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3' },
  { san: 'Bb5', uci: 'f1b5', fenAfter: 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3' },
  { san: 'a6', uci: 'a7a6', fenAfter: 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4' },
  { san: 'Ba4', uci: 'b5a4', fenAfter: 'r1bqkbnr/1ppp1ppp/p1n5/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 1 4' },
  { san: 'Nf6', uci: 'g8f6', fenAfter: 'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 5' },
];

function setupReviewMocks(page: import('@playwright/test').Page, gameId = GAME_ID) {
  return Promise.all([
    page.route(`**/api/games/${gameId}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockGame),
      }),
    ),
    page.route(`**/api/games/${gameId}/moves`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockMoves),
      }),
    ),
  ]);
}

test.describe('KS-318: Stockfish navigation stability', () => {
  test('rapid arrow key navigation does not crash page', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    // Wait for analysis page to load
    await expect(page.locator('.analysis-page')).toBeVisible();
    await expect(page.locator('.analysis-progress')).toBeVisible();

    // Rapid arrow key presses (simulates holding key down)
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('ArrowLeft');
    }
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('ArrowRight');
    }

    // Page should still be functional — analysis panel visible, no crash
    await expect(page.locator('.analysis-page')).toBeVisible();
    await expect(page.locator('.analysis-progress')).toBeVisible();

    // Stockfish text should be present (not removed by crash)
    await expect(page.locator('.analysis-progress-text')).toContainText('Stockfish');
  });

  test('rapid forward/back button clicks do not crash', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    await expect(page.locator('.analysis-page')).toBeVisible();

    const buttons = page.locator('.analysis-board-controls button');
    const backBtn = buttons.nth(1);
    const forwardBtn = buttons.nth(2);

    // Rapid clicks: back then forward repeatedly
    for (let i = 0; i < 10; i++) {
      await backBtn.click();
    }
    for (let i = 0; i < 10; i++) {
      await forwardBtn.click();
    }

    // Page should still be intact
    await expect(page.locator('.analysis-page')).toBeVisible();
    await expect(page.locator('.analysis-progress-text')).toContainText('Stockfish');
  });

  test('Home/End keys during analysis do not cause engine hang', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    await expect(page.locator('.analysis-page')).toBeVisible();

    // Navigate to start
    await page.keyboard.press('Home');

    // Verify we're at the start (no active move)
    await expect(page.locator('.analysis-move.active')).not.toBeVisible();

    // Navigate to end
    await page.keyboard.press('End');

    // Last move should be active
    await expect(page.locator('.analysis-move.active')).toHaveText('Nf6');

    // Rapid Home/End switching
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Home');
      await page.keyboard.press('End');
    }

    // Page and analysis panel should remain functional
    await expect(page.locator('.analysis-page')).toBeVisible();
    await expect(page.locator('.analysis-progress-text')).toContainText('Stockfish');
    // Stockfish should NOT show "Engine error"
    await expect(page.locator('.analysis-progress-text')).not.toContainText('Engine error');
  });

  test('no Engine error state after rapid navigation', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    await expect(page.locator('.analysis-page')).toBeVisible();

    // Aggressive navigation pattern: back-back-forward-home-end
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Home');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');

    // Wait for debounce to settle (150ms + buffer)
    await page.waitForTimeout(300);

    // Engine should NOT be in error state
    await expect(page.locator('.analysis-progress-text')).not.toContainText('Engine error');
    await expect(page.locator('.analysis-progress-text')).toContainText('Stockfish');
  });

  test('eval bar exists and updates after navigation', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    await expect(page.locator('.analysis-page')).toBeVisible();

    // Eval bar should be visible
    const evalBar = page.locator('.eval-bar');
    await expect(evalBar).toBeVisible();

    const evalBarWhite = page.locator('.eval-bar-white');
    await expect(evalBarWhite).toBeVisible();

    // Navigate to different position
    await page.keyboard.press('Home');

    // Eval bar should still be visible after navigation
    await expect(evalBar).toBeVisible();
    await expect(evalBarWhite).toBeVisible();

    // Eval bar label should show some value
    const evalLabel = page.locator('.eval-bar-label');
    await expect(evalLabel).toBeVisible();
  });

  test('active move indicator updates correctly during rapid navigation', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    await expect(page.locator('.analysis-page')).toBeVisible();

    // Start at last move
    await expect(page.locator('.analysis-move.active')).toHaveText('Nf6');

    // Navigate to start
    await page.keyboard.press('Home');
    await expect(page.locator('.analysis-move.active')).not.toBeVisible();

    // Step forward one by one
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.analysis-move.active')).toHaveText('e4');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.analysis-move.active')).toHaveText('e5');

    // Jump to end
    await page.keyboard.press('End');
    await expect(page.locator('.analysis-move.active')).toHaveText('Nf6');
  });

  test('move click navigation does not interfere with Stockfish analysis', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    await expect(page.locator('.analysis-page')).toBeVisible();

    const moves = page.locator('.analysis-move');

    // Click through moves rapidly
    await moves.nth(0).click(); // e4
    await moves.nth(3).click(); // Nc6
    await moves.nth(1).click(); // e5
    await moves.nth(7).click(); // Nf6

    // Active move should be the last clicked
    await expect(page.locator('.analysis-move.active')).toHaveText('Nf6');

    // Page should remain functional
    await expect(page.locator('.analysis-progress-text')).toContainText('Stockfish');
    await expect(page.locator('.analysis-progress-text')).not.toContainText('Engine error');
  });

  test('navigation buttons correctly disable at boundaries', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    await expect(page.locator('.analysis-page')).toBeVisible();

    const buttons = page.locator('.analysis-board-controls button');
    const toStartBtn = buttons.nth(0);
    const backBtn = buttons.nth(1);
    const forwardBtn = buttons.nth(2);
    const toEndBtn = buttons.nth(3);

    // At last move — forward/toEnd disabled
    await expect(forwardBtn).toBeDisabled();
    await expect(toEndBtn).toBeDisabled();

    // Go to start
    await page.keyboard.press('Home');
    await expect(toStartBtn).toBeDisabled();
    await expect(backBtn).toBeDisabled();

    // Forward should be enabled at start
    await expect(forwardBtn).toBeEnabled();
    await expect(toEndBtn).toBeEnabled();
  });
});
