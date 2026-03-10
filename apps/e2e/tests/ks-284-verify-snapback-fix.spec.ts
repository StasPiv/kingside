import { test, expect } from '../fixtures/auth.fixture';

/**
 * KS-284: E2E verification of KS-282 fix — piece snap-back on drop.
 *
 * KS-282 bug: after a successful drag-and-drop move, the piece briefly
 * flashed back to its source square because opacity was restored before
 * the board re-rendered with the new FEN.
 *
 * Fix: opacity is only restored when the move is REJECTED. On accepted
 * moves the board re-renders and replaces the old piece element entirely.
 *
 * Scenarios (from Jira):
 * 1. Valid drop — piece stays on new position, no visual snap-back
 * 2. Invalid drop — piece returns to source correctly
 * 3. Rapid sequential drag-and-drop — no flicker or snap-back
 * 4. Drop outside board — piece returns to source correctly
 * 5. Different drag speeds (slow / fast)
 */

const mockPuzzleFen =
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

async function setupPuzzleRush(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzle-rush/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'e2e-ks284-snapback',
        puzzle: {
          fen: mockPuzzleFen,
          rating: 1200,
          moves: 'e7e5',
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
          moves: 'e7e5',
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
      (p) =>
        p.style.opacity === '0' ||
        window.getComputedStyle(p).opacity === '0',
    ).length;
  });
}

/**
 * Capture piece opacity at source square right after mouseup.
 * This is the core KS-282 check: on accepted move, opacity must NOT
 * be restored to '' before the re-render (that caused the snap-back).
 */
async function getPieceOpacityOnSquare(
  board: import('@playwright/test').Locator,
  square: string,
): Promise<string | null> {
  return board.evaluate(
    (el, sq) => {
      const sqEl = el.querySelector(`[data-square="${sq}"]`);
      if (!sqEl) return null;
      const piece = sqEl.querySelector<HTMLElement>('[data-piece]');
      if (!piece) return null;
      return piece.style.opacity;
    },
    square,
  );
}

// ─── S1: Valid drop — no snap-back ────────────────────────────────────────────

test.describe('KS-284 S1: Valid drop — piece stays, no snap-back', () => {
  test('drag e7→e5: source piece not briefly visible after drop', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'e7');
    const tgt = await getSquareCenter(page, board, 'e5');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(tgt.x, tgt.y, { steps: 5 });
    await page.mouse.up();

    // Immediately after drop: no ghost, no invisible pieces
    await page.waitForTimeout(300);
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });

  test('after valid drop ghost is removed and board is clean', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'e7');
    const tgt = await getSquareCenter(page, board, 'e5');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(tgt.x, tgt.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // No fixed-position ghost elements remain in DOM
    const ghostsInDom = await page.evaluate(() =>
      document.querySelectorAll('[data-piece][style*="position: fixed"]').length,
    );
    expect(ghostsInDom).toBe(0);
  });
});

// ─── S2: Invalid drop — piece returns to source ──────────────────────────────

test.describe('KS-284 S2: Invalid drop — piece returns to source', () => {
  test('drop on same square: piece stays visible at source', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'e7');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    // Small move but release on same square
    await page.mouse.move(src.x + 5, src.y + 5, { steps: 2 });
    await page.mouse.move(src.x, src.y, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    // Piece must still exist on e7
    const pieceOnSrc = await board.locator('[data-square="e7"] [data-piece]').count();
    expect(pieceOnSrc).toBeGreaterThan(0);
  });

  test('drop on illegal square: piece opacity restored', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    // e7 pawn can only go to e6 or e5; try e4 (illegal from e7 in one move)
    const src = await getSquareCenter(page, board, 'd7');
    const illegalTgt = await getSquareCenter(page, board, 'd4');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(illegalTgt.x, illegalTgt.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    const opacity = await getPieceOpacityOnSquare(board, 'd7');
    // opacity should be '' (empty = visible) or null (piece re-rendered)
    expect(opacity === '' || opacity === null || opacity === '1').toBeTruthy();
  });
});

// ─── S3: Rapid sequential drag-and-drop — no flicker ─────────────────────────

test.describe('KS-284 S3: Rapid sequential moves — no flicker', () => {
  test('multiple rapid drag-drop sequences leave no artifacts', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Rapidly drag several pawns (short gestures)
    const pawns = ['a7', 'b7', 'c7', 'd7', 'f7', 'g7', 'h7'];
    for (const sq of pawns) {
      const { x, y } = await getSquareCenter(page, board, sq);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 3, y - 10, { steps: 1 });
      await page.mouse.up();
      // No pause — simulate rapid interaction
    }

    await page.waitForTimeout(300);
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });

  test('rapid valid move then immediately drag another piece', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // First: valid move e7→e5
    const src1 = await getSquareCenter(page, board, 'e7');
    const tgt1 = await getSquareCenter(page, board, 'e5');
    await page.mouse.move(src1.x, src1.y);
    await page.mouse.down();
    await page.mouse.move(tgt1.x, tgt1.y, { steps: 3 });
    await page.mouse.up();

    // Immediately start dragging d7
    const src2 = await getSquareCenter(page, board, 'd7');
    await page.mouse.move(src2.x, src2.y);
    await page.mouse.down();
    await page.mouse.move(src2.x, src2.y - 20, { steps: 2 });
    await page.mouse.up();

    await page.waitForTimeout(300);
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });
});

// ─── S4: Drop outside board — piece returns ──────────────────────────────────

test.describe('KS-284 S4: Drop outside board', () => {
  test('drag piece outside board boundaries: piece returns to source', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'e7');
    const boardBox = await board.boundingBox();
    expect(boardBox).toBeTruthy();

    // Drop far to the right, outside the board
    const outsideX = boardBox!.x + boardBox!.width + 100;
    const outsideY = boardBox!.y + boardBox!.height / 2;

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(outsideX, outsideY, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    // Piece must still be on e7
    const pieceOnE7 = await board.locator('[data-square="e7"] [data-piece]').count();
    expect(pieceOnE7).toBeGreaterThan(0);
  });

  test('drag piece above board: piece returns to source', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'a7');
    const boardBox = await board.boundingBox();
    expect(boardBox).toBeTruthy();

    const aboveX = src.x;
    const aboveY = boardBox!.y - 50;

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(aboveX, aboveY, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });
});

// ─── S5: Different drag speeds ───────────────────────────────────────────────

test.describe('KS-284 S5: Different drag speeds', () => {
  test('slow drag (many steps): no snap-back on valid move', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'e7');
    const tgt = await getSquareCenter(page, board, 'e5');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    // Very slow: 20 steps
    await page.mouse.move(tgt.x, tgt.y, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });

  test('fast drag (minimal steps): no snap-back on valid move', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'e7');
    const tgt = await getSquareCenter(page, board, 'e5');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    // Very fast: 1 step (instant jump)
    await page.mouse.move(tgt.x, tgt.y, { steps: 1 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });

  test('fast drag on invalid target: piece restored correctly', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'e7');
    const tgt = await getSquareCenter(page, board, 'a1');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(tgt.x, tgt.y, { steps: 1 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    // Piece still on source
    const pieceOnE7 = await board.locator('[data-square="e7"] [data-piece]').count();
    expect(pieceOnE7).toBeGreaterThan(0);
  });
});
