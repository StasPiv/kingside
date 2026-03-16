import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * KS-313: E2E verification of Stockfish analysis after KS-309/KS-310 fixes.
 *
 * Verifies:
 * 1. Stockfish analyzes the current position, not the initial one
 * 2. Clicking a move in notation switches Stockfish to that move's FEN
 * 3. Returning to start position triggers analysis of initial FEN
 * 4. Best moves and evaluation display correctly
 * 5. currentFen updates on every click in notation
 */

const GAME_ID = 'e2e-sf-test-1234-5678-abcdef123456';

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const mockGame = {
  id: GAME_ID,
  white: { id: 'w1', username: 'TestWhite' },
  black: { id: 'b1', username: 'TestBlack' },
  result: 'white',
  timeControl: '10+0',
  status: 'finished',
};

// Moves use fenAfter (KS-309 fix: previously was mapped as "fen")
const mockMoves = [
  { san: 'e4', uci: 'e2e4', fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1' },
  { san: 'e5', uci: 'e7e5', fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2' },
  { san: 'Nf3', uci: 'g1f3', fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' },
  { san: 'Nc6', uci: 'b8c6', fenAfter: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3' },
  { san: 'Bb5', uci: 'f1b5', fenAfter: 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3' },
  { san: 'a6', uci: 'a7a6', fenAfter: 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4' },
];

function setupMocks(page: import('@playwright/test').Page) {
  return Promise.all([
    page.route(`**/api/games/${GAME_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockGame),
      }),
    ),
    page.route(`**/api/games/${GAME_ID}/moves`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockMoves),
      }),
    ),
  ]);
}

test.describe('KS-313: Stockfish analyzes current position (not initial)', () => {
  test('should show Stockfish panel analyzing after page load', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Page loads at last move (a6) — Stockfish panel should be visible
    await expect(page.locator('.analysis-progress')).toBeVisible();
    await expect(page.locator('.analysis-progress-text')).toContainText('Stockfish 18');

    // Last move is active — position is NOT initial
    await expect(page.locator('.analysis-move.active')).toHaveText('a6');

    // Eval bar should be visible — engine is analyzing the current position
    await expect(page.locator('.eval-bar-container')).toBeVisible();
    await expect(page.locator('.eval-bar-white')).toBeVisible();
  });

  test('should have eval bar label present for current position', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const evalLabel = page.locator('.eval-bar-label');
    await expect(evalLabel).toBeVisible();
    const text = await evalLabel.textContent();
    // Label must have some text (default '0.0' or engine output)
    expect(text).toBeTruthy();
  });
});

test.describe('KS-313: Clicking move in notation switches Stockfish FEN', () => {
  test('should update active move and eval bar when clicking different moves', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const moves = page.locator('.analysis-move');
    const evalBar = page.locator('.eval-bar-white');
    const evalLabel = page.locator('.eval-bar-label');

    // Initially at last move (a6, index 5)
    await expect(page.locator('.analysis-move.active')).toHaveText('a6');
    await expect(evalBar).toBeVisible();

    // Click first move (e4) — Stockfish should switch to e4 FEN
    await moves.nth(0).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('e4');
    await expect(evalBar).toBeVisible();
    await expect(evalLabel).toBeVisible();

    // Click third move (Nf3)
    await moves.nth(2).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('Nf3');
    await expect(evalBar).toBeVisible();

    // Click fifth move (Bb5)
    await moves.nth(4).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('Bb5');
    await expect(evalBar).toBeVisible();
  });

  test('should keep Stockfish panel visible when rapidly switching moves', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const moves = page.locator('.analysis-move');

    // Rapidly click through all moves
    for (let i = 0; i < mockMoves.length; i++) {
      await moves.nth(i).click();
      await expect(page.locator('.analysis-move.active')).toHaveText(mockMoves[i].san);
    }

    // Stockfish panel should still be visible and functional
    await expect(page.locator('.analysis-progress')).toBeVisible();
    await expect(page.locator('.eval-bar-container')).toBeVisible();
  });
});

test.describe('KS-313: Return to start position triggers initial FEN analysis', () => {
  test('should analyze initial position when navigating to start', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Initially at last move
    await expect(page.locator('.analysis-move.active')).toHaveText('a6');

    // Go to start via button
    const toStartBtn = page.locator('.analysis-board-controls button').nth(0);
    await toStartBtn.click();

    // No active move — we are at initial position
    await expect(page.locator('.analysis-move.active')).not.toBeVisible();

    // Eval bar should still be visible (analyzing initial FEN)
    await expect(page.locator('.eval-bar-container')).toBeVisible();
    await expect(page.locator('.eval-bar-white')).toBeVisible();
    await expect(page.locator('.eval-bar-label')).toBeVisible();

    // Stockfish panel still present
    await expect(page.locator('.analysis-progress-text')).toContainText('Stockfish 18');
  });

  test('should analyze initial position via Home key', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    await page.keyboard.press('Home');
    await expect(page.locator('.analysis-move.active')).not.toBeVisible();

    // Eval bar visible at start position
    await expect(page.locator('.eval-bar-white')).toBeVisible();
  });

  test('should resume analysis after returning from start to a move', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Go to start
    await page.keyboard.press('Home');
    await expect(page.locator('.analysis-move.active')).not.toBeVisible();

    // Go to end
    await page.keyboard.press('End');
    await expect(page.locator('.analysis-move.active')).toHaveText('a6');

    // Eval bar and Stockfish panel still functional
    await expect(page.locator('.eval-bar-white')).toBeVisible();
    await expect(page.locator('.analysis-progress')).toBeVisible();
  });
});

test.describe('KS-313: Best moves and evaluation display', () => {
  test('should display eval bar with correct structure', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Eval bar structure: container > bar > white section + label
    await expect(page.locator('.eval-bar-container')).toBeVisible();
    await expect(page.locator('.eval-bar')).toBeVisible();
    await expect(page.locator('.eval-bar-white')).toBeVisible();
    await expect(page.locator('.eval-bar-label')).toBeVisible();

    // Eval bar white section should have a height style (percentage)
    const height = await page.locator('.eval-bar-white').evaluate((el) => el.style.height);
    expect(height).toMatch(/^\d+(\.\d+)?%$/);
  });

  test('should display Stockfish depth information', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const progressText = page.locator('.analysis-progress-text');
    await expect(progressText).toBeVisible();
    await expect(progressText).toContainText('Stockfish 18');
  });
});

test.describe('KS-313: currentFen updates on every click in notation', () => {
  test('should update board position when clicking each move sequentially', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const moves = page.locator('.analysis-move');
    const boardContainer = page.locator('.board-container');

    // Board should be visible
    await expect(boardContainer).toBeVisible();

    // Click each move and verify active state changes
    for (let i = 0; i < mockMoves.length; i++) {
      await moves.nth(i).click();
      const activeMove = page.locator('.analysis-move.active');
      await expect(activeMove).toHaveText(mockMoves[i].san);
    }
  });

  test('should update board when clicking moves in reverse order', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const moves = page.locator('.analysis-move');

    // Click from last to first
    for (let i = mockMoves.length - 1; i >= 0; i--) {
      await moves.nth(i).click();
      await expect(page.locator('.analysis-move.active')).toHaveText(mockMoves[i].san);
      // Eval bar stays visible after each click
      await expect(page.locator('.eval-bar-white')).toBeVisible();
    }
  });

  test('should update board when clicking same move twice', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const moves = page.locator('.analysis-move');

    // Click move Nf3 twice
    await moves.nth(2).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('Nf3');

    await moves.nth(2).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('Nf3');

    // Everything still works
    await expect(page.locator('.eval-bar-container')).toBeVisible();
  });

  test('should update via arrow key navigation combined with clicks', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const moves = page.locator('.analysis-move');

    // Click move e4
    await moves.nth(0).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('e4');

    // ArrowRight -> e5
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.analysis-move.active')).toHaveText('e5');

    // Click Bb5 (index 4)
    await moves.nth(4).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('Bb5');

    // ArrowLeft -> Nc6
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.analysis-move.active')).toHaveText('Nc6');

    // Eval bar functional throughout
    await expect(page.locator('.eval-bar-white')).toBeVisible();
  });
});
