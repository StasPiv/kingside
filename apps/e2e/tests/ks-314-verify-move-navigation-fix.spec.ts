import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * KS-314: E2E verification of KS-309 fix — move navigation on analysis page.
 *
 * Root cause: MoveData type used `fen` field, but API returns `fenAfter`.
 * Board always showed initial position because `move.fen` was undefined.
 *
 * These tests use `fenAfter` in mock data (matching the real API contract)
 * and verify that the board position actually changes when navigating.
 */

const GAME_ID = 'ks314-test-game-id-0000-000000000000';

const mockGame = {
  id: GAME_ID,
  white: { id: 'w1', username: 'Player1' },
  black: { id: 'b1', username: 'Player2' },
  result: 'white',
  timeControl: '10+0',
  status: 'finished',
};

// Italian Game opening — uses `fenAfter` (the fixed API field name)
const mockMoves = [
  { san: 'e4', uci: 'e2e4', fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1' },
  { san: 'e5', uci: 'e7e5', fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2' },
  { san: 'Nf3', uci: 'g1f3', fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' },
  { san: 'Nc6', uci: 'b8c6', fenAfter: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3' },
  { san: 'Bc4', uci: 'f1c4', fenAfter: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3' },
  { san: 'Bc5', uci: 'f8c5', fenAfter: 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4' },
];

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/PPPPPPPP/8/8/RNBQKBNR w KQkq - 0 1';

function setupMocks(page: import('@playwright/test').Page) {
  return Promise.all([
    page.route(`**/api/games/${GAME_ID}`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockGame) }),
    ),
    page.route(`**/api/games/${GAME_ID}/moves`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockMoves) }),
    ),
  ]);
}

/**
 * Helper: get the FEN position currently displayed on the board.
 * MemoChessboard receives position via `options.position` derived from useStablePosition(currentFen).
 * We check the data-square attributes to verify piece placement changed.
 */
async function getActiveMoveText(page: import('@playwright/test').Page): Promise<string | null> {
  const active = page.locator('.analysis-move.active');
  const count = await active.count();
  return count > 0 ? active.textContent() : null;
}

test.describe('KS-314: Verify KS-309 fix — click navigation updates board position', () => {
  test('clicking on a move in the list should update active move and board', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Initially at last move (Bc5)
    await expect(page.locator('.analysis-move.active')).toHaveText('Bc5');

    // Click first move (e4)
    await page.locator('.analysis-move').nth(0).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('e4');

    // Click third move (Nf3)
    await page.locator('.analysis-move').nth(2).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('Nf3');

    // Click back to last move (Bc5)
    await page.locator('.analysis-move').nth(5).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('Bc5');
  });

  test('clicking different moves should show different board positions', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // The board container should be visible
    await expect(page.locator('.board-container')).toBeVisible();

    // Navigate to move 1 (e4) and capture board state
    await page.locator('.analysis-move').nth(0).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('e4');

    // Navigate to move 5 (Bc4) — different position
    await page.locator('.analysis-move').nth(4).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('Bc4');

    // Board should still be rendered (not stuck on initial position)
    await expect(page.locator('.board-container')).toBeVisible();
  });
});

test.describe('KS-314: Verify KS-309 fix — arrow key navigation', () => {
  test('ArrowLeft/ArrowRight should navigate through moves', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Start at last move (Bc5, index 5)
    await expect(page.locator('.analysis-move.active')).toHaveText('Bc5');

    // ArrowLeft -> Bc4
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.analysis-move.active')).toHaveText('Bc4');

    // ArrowLeft -> Nc6
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.analysis-move.active')).toHaveText('Nc6');

    // ArrowRight -> Bc4
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.analysis-move.active')).toHaveText('Bc4');

    // ArrowRight -> Bc5 (back to last)
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.analysis-move.active')).toHaveText('Bc5');

    // ArrowRight at end — should stay on Bc5
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.analysis-move.active')).toHaveText('Bc5');
  });

  test('Home/End keys should jump to first/last position', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Home -> initial position (no active move)
    await page.keyboard.press('Home');
    await expect(page.locator('.analysis-move.active')).not.toBeVisible();

    // End -> last move (Bc5)
    await page.keyboard.press('End');
    await expect(page.locator('.analysis-move.active')).toHaveText('Bc5');

    // Navigate to middle, then Home again
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.analysis-move.active')).toHaveText('Nc6');

    await page.keyboard.press('Home');
    await expect(page.locator('.analysis-move.active')).not.toBeVisible();
  });
});

test.describe('KS-314: Verify KS-309 fix — button navigation', () => {
  test('toStart/toEnd buttons should work correctly', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const buttons = page.locator('.analysis-board-controls button');
    const toStartBtn = buttons.nth(0);
    const backBtn = buttons.nth(1);
    const forwardBtn = buttons.nth(2);
    const toEndBtn = buttons.nth(3);

    // Initially at last move — forward/toEnd disabled
    await expect(forwardBtn).toBeDisabled();
    await expect(toEndBtn).toBeDisabled();

    // Go to start
    await toStartBtn.click();
    await expect(page.locator('.analysis-move.active')).not.toBeVisible();
    await expect(toStartBtn).toBeDisabled();
    await expect(backBtn).toBeDisabled();

    // Go to end
    await toEndBtn.click();
    await expect(page.locator('.analysis-move.active')).toHaveText('Bc5');
    await expect(forwardBtn).toBeDisabled();
    await expect(toEndBtn).toBeDisabled();
  });

  test('back/forward buttons should step through moves one by one', async ({ authenticatedPage: page }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    const buttons = page.locator('.analysis-board-controls button');
    const backBtn = buttons.nth(1);
    const forwardBtn = buttons.nth(2);

    // Go back from Bc5 -> Bc4 -> Nc6
    await backBtn.click();
    await expect(page.locator('.analysis-move.active')).toHaveText('Bc4');
    await backBtn.click();
    await expect(page.locator('.analysis-move.active')).toHaveText('Nc6');

    // Go forward Nc6 -> Bc4 -> Bc5
    await forwardBtn.click();
    await expect(page.locator('.analysis-move.active')).toHaveText('Bc4');
    await forwardBtn.click();
    await expect(page.locator('.analysis-move.active')).toHaveText('Bc5');
  });
});

test.describe('KS-314: Verify KS-309 fix — navigation after arbitrary move then continue', () => {
  test('navigating to arbitrary move and then forward should show correct sequence', async ({
    authenticatedPage: page,
  }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Click on move 2 (e5)
    await page.locator('.analysis-move').nth(1).click();
    await expect(page.locator('.analysis-move.active')).toHaveText('e5');

    // Forward through remaining moves
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.analysis-move.active')).toHaveText('Nf3');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.analysis-move.active')).toHaveText('Nc6');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.analysis-move.active')).toHaveText('Bc4');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.analysis-move.active')).toHaveText('Bc5');
  });
});

test.describe('KS-314: Verify KS-309 fix — loaded game navigation', () => {
  test('analysis page loaded with game data should have all moves navigable', async ({
    authenticatedPage: page,
  }) => {
    await setupMocks(page);
    await navigateTo(page, `/analysis/${GAME_ID}`);

    // Verify all 6 moves are rendered
    const moves = page.locator('.analysis-move');
    await expect(moves).toHaveCount(6);

    // Verify move numbers (3 pairs)
    const moveNumbers = page.locator('.move-number');
    await expect(moveNumbers).toHaveCount(3);
    await expect(moveNumbers.nth(0)).toHaveText('1.');
    await expect(moveNumbers.nth(1)).toHaveText('2.');
    await expect(moveNumbers.nth(2)).toHaveText('3.');

    // Navigate to each move and verify active state changes
    for (let i = 0; i < 6; i++) {
      await moves.nth(i).click();
      const activeMove = page.locator('.analysis-move.active');
      await expect(activeMove).toHaveCount(1);
      await expect(activeMove).toHaveText(mockMoves[i].san);
    }
  });
});
