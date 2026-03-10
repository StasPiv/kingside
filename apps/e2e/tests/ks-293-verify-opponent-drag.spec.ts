import { test, expect } from '../fixtures/auth.fixture';

/**
 * KS-293: E2E verification of KS-291 fix — piece sticking when trying
 * to drag opponent's piece in puzzle mode.
 *
 * Scenarios:
 * 1. Dragging opponent's piece — drag must not start, no ghost created
 * 2. Dragging own piece — drag works normally
 * 3. Quick click on opponent's piece — piece must not stick
 * 4. Touch events on opponent's piece — same behavior
 * 5. After failed opponent drag, own piece drag still works
 */

test.use({
  video: 'on',
  screenshot: 'on',
});

// White to move — user plays as white
const mockPuzzleFen =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

async function setupPuzzleRush(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzle-rush/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'e2e-ks293-verify',
        puzzle: {
          fen: mockPuzzleFen,
          rating: 1200,
          moves: 'e2e4',
        },
        timeMode: '3',
        durationMs: 180000,
        lives: 3,
      }),
    });
  });

  await page.route('**/api/puzzle-rush/solve', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        correct: true,
        score: 1,
        lives: 3,
        finished: false,
        nextPuzzle: {
          fen: mockPuzzleFen,
          rating: 1300,
          moves: 'e2e4',
        },
      }),
    });
  });

  await page.goto('/puzzle-rush');
  await page.locator('.play-btn').click();
  await expect(page.locator('.board-container')).toBeVisible({
    timeout: 10_000,
  });
}

async function countGhosts(
  page: import('@playwright/test').Page,
): Promise<number> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-piece]')).filter(
      (el) => (el as HTMLElement).style.position === 'fixed',
    ).length,
  );
}

async function getInvisiblePieceCount(
  page: import('@playwright/test').Page,
  container: import('@playwright/test').Locator,
): Promise<number> {
  return container.evaluate((el) => {
    const pieces = el.querySelectorAll<HTMLElement>('[data-piece]');
    return Array.from(pieces).filter(
      (p) => p.style.opacity === '0' || window.getComputedStyle(p).opacity === '0',
    ).length;
  });
}

async function getSquareCenter(
  page: import('@playwright/test').Page,
  board: import('@playwright/test').Locator,
  square: string,
): Promise<{ x: number; y: number }> {
  const el = board.locator(`[data-square="${square}"]`);
  await el.waitFor({ state: 'visible', timeout: 5000 });
  const box = await el.boundingBox();
  expect(box).toBeTruthy();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

// ─── S1: Opponent piece drag must not start ──────────────────────────────────

test.describe('KS-293 S1: Opponent piece drag must not start', () => {
  test('no ghost created when dragging opponent (black) piece', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // e7 has a black pawn — opponent's piece when orientation is white
    const { x, y } = await getSquareCenter(page, board, 'e7');

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(100);

    // No ghost should be created for opponent's piece
    expect(await countGhosts(page)).toBe(0);

    // No pieces should become invisible
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    // Try to move while holding — still no ghost
    const target = await getSquareCenter(page, board, 'e5');
    await page.mouse.move(target.x, target.y);
    await page.waitForTimeout(50);
    expect(await countGhosts(page)).toBe(0);

    await page.mouse.up();
    await page.waitForTimeout(200);

    // After release — board is clean
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });

  test('opponent piece stays on its square after drag attempt', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const { x, y } = await getSquareCenter(page, board, 'd7');

    // Attempt to drag opponent's d7 pawn to d5
    await page.mouse.move(x, y);
    await page.mouse.down();
    const d5 = await getSquareCenter(page, board, 'd5');
    await page.mouse.move(d5.x, d5.y);
    await page.mouse.up();
    await page.waitForTimeout(200);

    // Piece must still be on d7
    const pieceCount = await board.locator('[data-square="d7"] [data-piece]').count();
    expect(pieceCount).toBeGreaterThan(0);
  });
});

// ─── S2: Own piece drag works normally ───────────────────────────────────────

test.describe('KS-293 S2: Own piece drag works normally', () => {
  test('ghost created when dragging own (white) piece', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const { x, y } = await getSquareCenter(page, board, 'e2');

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(100);

    // Ghost MUST exist for own piece
    expect(await countGhosts(page)).toBe(1);

    await page.mouse.up();
    await page.waitForTimeout(200);

    // Clean up after release
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });
});

// ─── S3: Quick click on opponent's piece — no sticking ───────────────────────

test.describe('KS-293 S3: Quick click on opponent piece — no sticking', () => {
  test('rapid click on opponent piece does not leave stuck ghost', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const { x, y } = await getSquareCenter(page, board, 'b8');

    // Rapid click (mousedown + mouseup without movement)
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(200);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    // Piece still on its square
    const pieceCount = await board.locator('[data-square="b8"] [data-piece]').count();
    expect(pieceCount).toBeGreaterThan(0);
  });

  test('multiple rapid clicks on different opponent pieces', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const squares = ['a7', 'b7', 'c7', 'd7', 'e7', 'f7', 'g7', 'h7'];

    for (const sq of squares) {
      const { x, y } = await getSquareCenter(page, board, sq);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.up();
    }

    await page.waitForTimeout(200);

    // No ghosts or invisible pieces after clicking all opponent pawns
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });
});

// ─── S4: Touch events on opponent piece ──────────────────────────────────────

test.describe('KS-293 S4: Touch events on opponent piece', () => {
  test.use({ ...({ hasTouch: true } as object) });

  test('touch drag on opponent piece does not create ghost', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const { x, y } = await getSquareCenter(page, board, 'e7');

    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(200);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });
});

// ─── S5: Own piece drag works after failed opponent drag ─────────────────────

test.describe('KS-293 S5: Own drag works after failed opponent drag', () => {
  test('can drag own piece after attempting to drag opponent piece', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Step 1: Try to drag opponent's piece (should fail silently)
    const opp = await getSquareCenter(page, board, 'e7');
    await page.mouse.move(opp.x, opp.y);
    await page.mouse.down();
    await page.mouse.move(opp.x, opp.y - 100);
    await page.mouse.up();
    await page.waitForTimeout(200);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    // Step 2: Drag own piece — must work correctly
    const own = await getSquareCenter(page, board, 'e2');
    await page.mouse.move(own.x, own.y);
    await page.mouse.down();
    await page.waitForTimeout(100);

    // Ghost must appear for own piece
    expect(await countGhosts(page)).toBe(1);

    // Move towards e4
    const e4 = await getSquareCenter(page, board, 'e4');
    await page.mouse.move(e4.x, e4.y);
    await page.waitForTimeout(50);

    // Ghost still present during drag
    expect(await countGhosts(page)).toBe(1);

    await page.mouse.up();
    await page.waitForTimeout(200);

    // Clean state after drop
    expect(await countGhosts(page)).toBe(0);
  });

  test('alternating opponent and own piece drags work correctly', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Attempt opponent drag
    const a7 = await getSquareCenter(page, board, 'a7');
    await page.mouse.move(a7.x, a7.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(100);
    expect(await countGhosts(page)).toBe(0);

    // Own piece drag
    const a2 = await getSquareCenter(page, board, 'a2');
    await page.mouse.move(a2.x, a2.y);
    await page.mouse.down();
    await page.waitForTimeout(100);
    expect(await countGhosts(page)).toBe(1);
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await countGhosts(page)).toBe(0);

    // Another opponent drag attempt
    const h7 = await getSquareCenter(page, board, 'h7');
    await page.mouse.move(h7.x, h7.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(100);
    expect(await countGhosts(page)).toBe(0);

    // Another own piece drag
    const h2 = await getSquareCenter(page, board, 'h2');
    await page.mouse.move(h2.x, h2.y);
    await page.mouse.down();
    await page.waitForTimeout(100);
    expect(await countGhosts(page)).toBe(1);
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await countGhosts(page)).toBe(0);

    // Board clean
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });
});
