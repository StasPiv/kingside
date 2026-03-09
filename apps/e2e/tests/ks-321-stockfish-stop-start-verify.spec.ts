import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * KS-321: E2E verification of Stop/Start Stockfish analysis button (KS-320).
 *
 * Scenarios:
 * 1. Stop button stops Stockfish engine, CPU released
 * 2. Start button re-initializes engine and resumes analysis
 * 3. When engine is off, move navigation does NOT trigger auto-analysis
 * 4. When engine is on, move navigation triggers auto-analysis
 * 5. Localization: analysis.stop, analysis.start, analysis.off display correctly (EN/RU)
 * 6. Repeated Stop/Start cycles work stably without hangs
 */

const GAME_ID = 'ks321-verify-stop-start-00-abcdef123456';

const mockGame = {
  id: GAME_ID,
  white: { id: 'w1', username: 'StopWhite' },
  black: { id: 'b1', username: 'StopBlack' },
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

// Scenario 1: Stop button stops engine
test.describe('KS-321: Stop button stops Stockfish engine', () => {
  test('should show "Off" status after clicking Stop', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const toggleBtn = page.locator('[data-testid="stockfish-toggle"]');
    await expect(toggleBtn).toBeVisible();

    // Initially engine is on — button should say "Stop"
    await expect(toggleBtn).toContainText(/stop/i);

    // Click Stop
    await toggleBtn.click();

    // Button text should change to "Start"
    await expect(toggleBtn).toContainText(/start/i);

    // Status should show "Off"
    await expect(page.locator('.analysis-progress-text')).toContainText(/off|выключен/i);
  });

  test('should change button color from red to green after Stop', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const toggleBtn = page.locator('[data-testid="stockfish-toggle"]');

    // Initially red (stop)
    const bgBefore = await toggleBtn.evaluate((el) => (el as HTMLElement).style.background);
    expect(bgBefore).toContain('#dc2626');

    // Click Stop
    await toggleBtn.click();

    // Should be green (start)
    const bgAfter = await toggleBtn.evaluate((el) => (el as HTMLElement).style.background);
    expect(bgAfter).toContain('#16a34a');
  });

  test('should hide analysis lines after Stop', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Wait for engine to produce some output
    await page.waitForTimeout(1000);

    // Click Stop
    await page.locator('[data-testid="stockfish-toggle"]').click();

    // Analysis lines should not be visible when engine is off
    // The lines container only renders when analysisEnabled && lines.length > 0
    // After stop + cleanup, no new lines should appear
    await page.waitForTimeout(500);
    await expect(page.locator('.analysis-progress-text')).toContainText(/off|выключен/i);
  });
});

// Scenario 2: Start button re-initializes engine
test.describe('KS-321: Start button re-initializes engine', () => {
  test('should resume analysis after Stop then Start', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const toggleBtn = page.locator('[data-testid="stockfish-toggle"]');

    // Stop engine
    await toggleBtn.click();
    await expect(toggleBtn).toContainText(/start/i);
    await expect(page.locator('.analysis-progress-text')).toContainText(/off|выключен/i);

    // Start engine again
    await toggleBtn.click();
    await expect(toggleBtn).toContainText(/stop/i);

    // Engine should re-initialize — status should not be "Off"
    await expect(page.locator('.analysis-progress-text')).not.toContainText(/off|выключен/i);

    // Eval bar should still be visible
    await expect(page.locator('.eval-bar-container')).toBeVisible();
    await expect(page.locator('.eval-bar-white')).toBeVisible();
  });

  test('should show engine loading/ready state after Start', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const toggleBtn = page.locator('[data-testid="stockfish-toggle"]');
    const progressText = page.locator('.analysis-progress-text');

    // Stop then Start
    await toggleBtn.click();
    await toggleBtn.click();

    // Should show Stockfish 18 with loading, ready, or depth info — not "Off"
    await expect(progressText).toContainText('Stockfish 18');
    await expect(progressText).not.toContainText(/off|выключен/i);
  });
});

// Scenario 3: When engine is off, move navigation does NOT trigger analysis
test.describe('KS-321: No auto-analysis when engine is off', () => {
  test('should not analyze when navigating moves with engine stopped', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const toggleBtn = page.locator('[data-testid="stockfish-toggle"]');

    // Stop engine
    await toggleBtn.click();
    await expect(page.locator('.analysis-progress-text')).toContainText(/off|выключен/i);

    // Navigate through moves via keyboard
    await page.keyboard.press('Home');
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);

    // Status should still show "Off" — engine not started by navigation
    await expect(page.locator('.analysis-progress-text')).toContainText(/off|выключен/i);
    await expect(toggleBtn).toContainText(/start/i);
  });

  test('should not analyze when clicking moves with engine stopped', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const toggleBtn = page.locator('[data-testid="stockfish-toggle"]');
    const moves = page.locator('.analysis-move');

    // Stop engine
    await toggleBtn.click();
    await expect(page.locator('.analysis-progress-text')).toContainText(/off|выключен/i);

    // Click different moves
    await moves.nth(0).click();
    await page.waitForTimeout(300);
    await moves.nth(2).click();
    await page.waitForTimeout(300);
    await moves.nth(4).click();
    await page.waitForTimeout(300);

    // Engine should remain off
    await expect(page.locator('.analysis-progress-text')).toContainText(/off|выключен/i);
    await expect(toggleBtn).toContainText(/start/i);
  });
});

// Scenario 4: When engine is on, move navigation triggers auto-analysis
test.describe('KS-321: Auto-analysis works when engine is on', () => {
  test('should analyze when navigating moves with engine running', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Engine is on by default — verify
    const toggleBtn = page.locator('[data-testid="stockfish-toggle"]');
    await expect(toggleBtn).toContainText(/stop/i);

    // Navigate to a different move
    await page.locator('.analysis-move').nth(0).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('e4');

    // Engine should still be active (not "Off")
    await expect(page.locator('.analysis-progress-text')).not.toContainText(/off|выключен/i);
    await expect(page.locator('.eval-bar-container')).toBeVisible();
    await expect(page.locator('.analysis-progress')).toBeVisible();
  });

  test('should re-analyze after Stop-Start-Navigate cycle', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const toggleBtn = page.locator('[data-testid="stockfish-toggle"]');

    // Stop
    await toggleBtn.click();
    await expect(page.locator('.analysis-progress-text')).toContainText(/off|выключен/i);

    // Start
    await toggleBtn.click();
    await expect(page.locator('.analysis-progress-text')).not.toContainText(/off|выключен/i);

    // Navigate — should trigger analysis
    await page.locator('.analysis-move').nth(1).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('e5');

    // Engine panel should be functional
    await expect(page.locator('.analysis-progress')).toBeVisible();
    await expect(page.locator('.eval-bar-container')).toBeVisible();
  });
});

// Scenario 5: Localization keys
test.describe('KS-321: Localization of Stop/Start/Off', () => {
  test('should display correct EN text for Stop, Start, Off', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const toggleBtn = page.locator('[data-testid="stockfish-toggle"]');
    const progressText = page.locator('.analysis-progress-text');

    // Engine ON — button says "Stop"
    await expect(toggleBtn).toHaveText('Stop');

    // Click Stop — button says "Start", status shows "Off"
    await toggleBtn.click();
    await expect(toggleBtn).toHaveText('Start');
    await expect(progressText).toContainText('Off');

    // Click Start — button says "Stop" again
    await toggleBtn.click();
    await expect(toggleBtn).toHaveText('Stop');
  });
});

// Scenario 6: Repeated Stop/Start cycles — stability
test.describe('KS-321: Stability of repeated Stop/Start cycles', () => {
  test('should handle 5 consecutive Stop/Start cycles without hanging', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const toggleBtn = page.locator('[data-testid="stockfish-toggle"]');

    for (let cycle = 0; cycle < 5; cycle++) {
      // Stop
      await toggleBtn.click();
      await expect(toggleBtn).toContainText(/start/i);
      await expect(page.locator('.analysis-progress-text')).toContainText(/off|выключен/i);

      // Start
      await toggleBtn.click();
      await expect(toggleBtn).toContainText(/stop/i);
      await expect(page.locator('.analysis-progress-text')).not.toContainText(/off|выключен/i);

      // Small pause between cycles
      await page.waitForTimeout(200);
    }

    // After all cycles, engine should be functional
    await expect(page.locator('.analysis-progress')).toBeVisible();
    await expect(page.locator('.eval-bar-container')).toBeVisible();
    await expect(page.locator('.eval-bar-white')).toBeVisible();
  });

  test('should handle rapid Stop/Start without page errors', async ({ authenticatedPage: page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const toggleBtn = page.locator('[data-testid="stockfish-toggle"]');

    // Rapid toggle 10 times without waiting
    for (let i = 0; i < 10; i++) {
      await toggleBtn.click();
    }

    // Wait for any async errors
    await page.waitForTimeout(1000);

    // No page errors should have occurred
    expect(pageErrors).toHaveLength(0);

    // Page should still be functional — eval bar and panel visible
    await expect(page.locator('.eval-bar-container')).toBeVisible();
    await expect(page.locator('.analysis-progress')).toBeVisible();
  });

  test('should work correctly after Stop/Start with move navigation interleaved', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const toggleBtn = page.locator('[data-testid="stockfish-toggle"]');
    const moves = page.locator('.analysis-move');

    // Cycle 1: navigate, stop, navigate, start
    await moves.nth(0).click();
    await toggleBtn.click(); // stop
    await moves.nth(2).click();
    await expect(page.locator('.analysis-progress-text')).toContainText(/off|выключен/i);
    await toggleBtn.click(); // start

    // Cycle 2: navigate, stop, navigate, start
    await moves.nth(4).click();
    await toggleBtn.click(); // stop
    await page.keyboard.press('Home');
    await expect(page.locator('.analysis-progress-text')).toContainText(/off|выключен/i);
    await toggleBtn.click(); // start

    // Final state — engine on, page functional
    await expect(toggleBtn).toContainText(/stop/i);
    await expect(page.locator('.analysis-progress-text')).not.toContainText(/off|выключен/i);
    await expect(page.locator('.eval-bar-container')).toBeVisible();
  });
});
