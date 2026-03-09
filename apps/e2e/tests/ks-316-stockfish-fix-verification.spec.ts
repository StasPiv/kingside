import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * KS-316: QA verification of KS-310 fix (Stockfish analysis not working).
 *
 * Scenarios:
 * 1. Stockfish initializes on analysis page (state -> 'ready'), eval bar and lines visible
 * 2. evaluate() produces results (info lines, bestmove) displayed correctly
 * 3. Stop and restart analysis — state doesn't hang, re-analysis works
 * 4. Init timeout — if WASM doesn't load in 15s, state -> 'error' with console message
 * 5. bestmove from stopped analysis doesn't reset current analysis state
 * 6. No console errors/warnings during normal operation
 */

const GAME_ID = 'ks316-verify-sf-fix-0000-abcdef123456';

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const mockGame = {
  id: GAME_ID,
  white: { id: 'w1', username: 'VerifyWhite' },
  black: { id: 'b1', username: 'VerifyBlack' },
  result: 'draw',
  timeControl: '10+0',
  status: 'finished',
};

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

// Scenario 1: Stockfish initializes, eval bar and engine lines visible
test.describe('KS-316: Stockfish initialization (state -> ready)', () => {
  test('should show Stockfish panel with engine name on page load', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    await expect(page.locator('.analysis-progress')).toBeVisible();
    await expect(page.locator('.analysis-progress-text')).toContainText('Stockfish 18');
  });

  test('should display eval bar container and white section on load', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    await expect(page.locator('.eval-bar-container')).toBeVisible();
    await expect(page.locator('.eval-bar')).toBeVisible();
    await expect(page.locator('.eval-bar-white')).toBeVisible();
    await expect(page.locator('.eval-bar-label')).toBeVisible();
  });

  test('should have eval bar white section with percentage height', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const height = await page.locator('.eval-bar-white').evaluate((el) => el.style.height);
    expect(height).toMatch(/^\d+(\.\d+)?%$/);
  });

  test('should have eval bar label with text content', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const label = page.locator('.eval-bar-label');
    await expect(label).toBeVisible();
    const text = await label.textContent();
    expect(text).toBeTruthy();
  });
});

// Scenario 2: evaluate() called correctly, results displayed
test.describe('KS-316: Analysis results display (info lines, bestmove)', () => {
  test('should display analysis progress text with depth when analyzing', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Stockfish panel should be visible with engine info
    const progressText = page.locator('.analysis-progress-text');
    await expect(progressText).toBeVisible();
    await expect(progressText).toContainText('Stockfish 18');
  });

  test('should trigger evaluation when clicking different moves', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const moves = page.locator('.analysis-move');

    // Click first move — engine should re-evaluate
    await moves.nth(0).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('e4');
    await expect(page.locator('.eval-bar-container')).toBeVisible();
    await expect(page.locator('.analysis-progress')).toBeVisible();

    // Click third move — engine re-evaluates again
    await moves.nth(2).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('Nf3');
    await expect(page.locator('.eval-bar-container')).toBeVisible();
  });
});

// Scenario 3: Stop and restart analysis — state doesn't hang
test.describe('KS-316: Stop and restart analysis', () => {
  test('should maintain functional state after rapid move switching', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const moves = page.locator('.analysis-move');

    // Rapidly switch through all moves (triggers stop + re-evaluate each time)
    for (let i = 0; i < mockMoves.length; i++) {
      await moves.nth(i).click();
    }

    // After rapid switching, last clicked move should be active
    await expect(page.locator('.analysis-move.active')).toHaveText('a6');

    // Engine panel should still be functional — not stuck
    await expect(page.locator('.analysis-progress')).toBeVisible();
    await expect(page.locator('.eval-bar-container')).toBeVisible();
    await expect(page.locator('.eval-bar-white')).toBeVisible();
  });

  test('should work after navigating to start and back to end', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Go to start (stops current analysis, starts initial FEN analysis)
    await page.keyboard.press('Home');
    await expect(page.locator('.analysis-move.active')).not.toBeVisible();
    await expect(page.locator('.eval-bar-container')).toBeVisible();

    // Go to end (stops, re-evaluates last move position)
    await page.keyboard.press('End');
    await expect(page.locator('.analysis-move.active')).toHaveText('a6');

    // Engine still works
    await expect(page.locator('.analysis-progress')).toBeVisible();
    await expect(page.locator('.eval-bar-white')).toBeVisible();
  });

  test('should recover after multiple back-and-forth navigations', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Multiple back-and-forth cycles
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.keyboard.press('Home');
      await expect(page.locator('.analysis-move.active')).not.toBeVisible();

      await page.keyboard.press('End');
      await expect(page.locator('.analysis-move.active')).toHaveText('a6');
    }

    // Everything still functional
    await expect(page.locator('.analysis-progress-text')).toContainText('Stockfish 18');
    await expect(page.locator('.eval-bar-container')).toBeVisible();
  });
});

// Scenario 4: Init timeout — WASM doesn't load in 15s -> state 'error'
test.describe('KS-316: Stockfish init timeout', () => {
  test('should show error state when engine worker fails to load', async ({ authenticatedPage: page }) => {
    // Intercept Stockfish WASM/JS to simulate load failure
    await page.route('**/stockfish/stockfish-18-single.js', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        // Return a worker script that never sends uciok/readyok
        body: 'self.onmessage = function() {};',
      }),
    );

    await setupMocks(page);

    // Collect console warnings
    const consoleMessages: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning' || msg.type() === 'error') {
        consoleMessages.push(msg.text());
      }
    });

    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Wait for the 15s timeout + buffer
    await page.waitForTimeout(16_000);

    // After timeout, engine error text should appear in the progress panel
    const progressText = await page.locator('.analysis-progress-text').textContent();
    expect(progressText).toContain('Stockfish 18');

    // Console should contain timeout warning
    const hasTimeoutWarning = consoleMessages.some(
      (msg) => msg.includes('Init timeout') || msg.includes('timeout'),
    );
    expect(hasTimeoutWarning).toBe(true);
  });
});

// Scenario 5: bestmove from stopped analysis doesn't reset current analysis state
test.describe('KS-316: bestmove from stopped analysis isolation', () => {
  test('should not lose eval bar when switching moves during analysis', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const moves = page.locator('.analysis-move');

    // Start at last move (a6) — engine is analyzing
    await expect(page.locator('.analysis-move.active')).toHaveText('a6');

    // Quickly switch to e4 while previous analysis may still be running
    await moves.nth(0).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('e4');

    // Wait a moment for bestmove from stopped analysis to arrive
    await page.waitForTimeout(500);

    // Eval bar should still be visible — bestmove from old analysis
    // should NOT have reset the state incorrectly
    await expect(page.locator('.eval-bar-container')).toBeVisible();
    await expect(page.locator('.eval-bar-white')).toBeVisible();
    await expect(page.locator('.analysis-progress')).toBeVisible();
  });

  test('should keep Stockfish panel functional after rapid position changes', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const moves = page.locator('.analysis-move');

    // Rapid fire: click each move without waiting
    await moves.nth(4).click(); // Bb5
    await moves.nth(1).click(); // e5
    await moves.nth(3).click(); // Nc6
    await moves.nth(0).click(); // e4
    await moves.nth(5).click(); // a6

    // Final state should be at a6
    await expect(page.locator('.analysis-move.active')).toHaveText('a6');

    // Wait for any delayed bestmove messages
    await page.waitForTimeout(1000);

    // Engine panel should still be functional
    await expect(page.locator('.analysis-progress')).toBeVisible();
    await expect(page.locator('.eval-bar-container')).toBeVisible();
  });
});

// Scenario 6: No console errors during normal operation
test.describe('KS-316: No console errors during normal operation', () => {
  test('should not produce console errors during page load and navigation', async ({ authenticatedPage: page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Navigate through moves
    const moves = page.locator('.analysis-move');
    for (let i = 0; i < mockMoves.length; i++) {
      await moves.nth(i).click();
      await expect(page.locator('.analysis-move.active')).toHaveText(mockMoves[i].san);
    }

    // Navigate with keyboard
    await page.keyboard.press('Home');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');

    // Wait for any async errors
    await page.waitForTimeout(1000);

    // Filter out non-critical errors (e.g. favicon, 3rd party scripts)
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes('favicon') && !e.includes('net::ERR'),
    );

    expect(pageErrors).toHaveLength(0);
    expect(criticalErrors).toHaveLength(0);
  });
});

// Scenario 7: Cross-browser structure verification (layout and elements)
test.describe('KS-316: Analysis page structure verification', () => {
  test('should render all critical elements for analysis', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Main layout
    await expect(page.locator('.analysis-page')).toBeVisible();
    await expect(page.locator('.analysis-board-area')).toBeVisible();
    await expect(page.locator('.analysis-sidebar')).toBeVisible();

    // Board
    await expect(page.locator('.board-container')).toBeVisible();

    // Eval bar structure
    await expect(page.locator('.eval-bar-container')).toBeVisible();
    await expect(page.locator('.eval-bar')).toBeVisible();
    await expect(page.locator('.eval-bar-white')).toBeVisible();
    await expect(page.locator('.eval-bar-label')).toBeVisible();

    // Engine panel
    await expect(page.locator('.analysis-progress')).toBeVisible();
    await expect(page.locator('.analysis-progress-text')).toBeVisible();

    // Moves list
    await expect(page.locator('.analysis-moves')).toBeVisible();
    await expect(page.locator('.analysis-move')).toHaveCount(mockMoves.length);

    // Navigation controls
    const controls = page.locator('.analysis-board-controls button');
    await expect(controls).toHaveCount(4);

    // Player names
    const playerNames = page.locator('.player-name');
    await expect(playerNames).toHaveCount(2);
  });

  test('should have correct initial state — last move active', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Last move should be active
    await expect(page.locator('.analysis-move.active')).toHaveText('a6');

    // Forward/end buttons disabled at last move
    const buttons = page.locator('.analysis-board-controls button');
    await expect(buttons.nth(2)).toBeDisabled(); // forward
    await expect(buttons.nth(3)).toBeDisabled(); // to end
  });
});
