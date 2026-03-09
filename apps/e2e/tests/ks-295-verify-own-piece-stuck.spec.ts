import { test, expect } from '../fixtures/auth.fixture';

/**
 * KS-295: E2E verification of KS-294 fix — own piece sticking on impossible
 * move in puzzle mode.
 *
 * KS-294 bug: when a player drags their own piece to an invalid square in
 * puzzle mode, onPieceDrop returns false but the piece's opacity stays at 0
 * and the ghost element may remain on the board. The fix added try-catch
 * around onPieceDrop and a fallback DOM query to restore opacity even when
 * React re-renders replace the original DOM element.
 *
 * Scenarios:
 * 1. Own piece impossible move — piece returns with opacity:1, no ghost
 * 2. Opponent piece drag blocked (regression KS-291) — no ghost
 * 3. Ghost element cleanup after impossible move (drag-and-drop)
 * 4. Opacity restored after multiple consecutive invalid moves
 * 5. Valid moves still work (no regression)
 */

test.use({
  video: 'on',
  screenshot: 'on',
});

// White to move — player is black, first move is opponent's setup move.
// After setup: black to move. Expected player move: e7e5.
const puzzleFen =
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const puzzleMoves = 'e7e5';

// Starting position — white to move, player is white.
const whiteToMoveFen =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

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

// ─── Setup helpers ──────────────────────────────────────────────────────────

async function setupPuzzlePage(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzles/next', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-ks295-puzzle',
        fen: puzzleFen,
        rating: 1200,
        moves: puzzleMoves,
        themes: ['opening'],
      }),
    });
  });

  await page.route('**/api/puzzles/*/attempt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ nextPuzzle: null }),
    });
  });

  await page.goto('/puzzle');
  await expect(page.locator('.board-container')).toBeVisible({
    timeout: 10_000,
  });
}

async function setupDailyPuzzlePage(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzles/daily', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        puzzle: {
          id: 'e2e-ks295-daily',
          fen: puzzleFen,
          rating: 1200,
          moves: puzzleMoves,
          themes: ['opening'],
        },
      }),
    });
  });

  await page.route('**/api/puzzles/daily/solve', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.goto('/daily');
  await expect(page.locator('.board-container')).toBeVisible({
    timeout: 10_000,
  });
}

async function setupPuzzleRush(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzle-rush/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'e2e-ks295-rush',
        puzzle: {
          fen: whiteToMoveFen,
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
          fen: whiteToMoveFen,
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

// ─── S1: Own piece impossible move — piece returns ──────────────────────────

test.describe('KS-295 S1: Own piece impossible move in puzzles', () => {
  test('PuzzlePage: wrong move returns piece with full opacity', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzlePage(page);
    const board = page.locator('.board-container');

    // Black to move. Expected: e7e5. Try wrong move: d7→d4 (invalid)
    const src = await getSquareCenter(page, board, 'd7');
    const tgt = await getSquareCenter(page, board, 'd4');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.waitForTimeout(100);

    // Ghost must exist during drag
    expect(await countGhosts(page)).toBe(1);

    await page.mouse.move(tgt.x, tgt.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // KS-294 core check: no stuck ghost, no invisible pieces
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(board)).toBe(0);

    // Piece must remain on source square d7
    const pieceOnD7 = await board
      .locator('[data-square="d7"] [data-piece]')
      .count();
    expect(pieceOnD7).toBeGreaterThan(0);
  });

  test('DailyPuzzlePage: wrong move returns piece with full opacity', async ({
    authenticatedPage: page,
  }) => {
    await setupDailyPuzzlePage(page);
    const board = page.locator('.board-container');

    // Invalid move: a7→a4
    const src = await getSquareCenter(page, board, 'a7');
    const tgt = await getSquareCenter(page, board, 'a4');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(tgt.x, tgt.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(board)).toBe(0);

    const pieceOnA7 = await board
      .locator('[data-square="a7"] [data-piece]')
      .count();
    expect(pieceOnA7).toBeGreaterThan(0);
  });

  test('PuzzleRush: wrong move returns piece with full opacity', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // White to move. Expected: e2e4. Try wrong move: a2→a5 (invalid)
    const src = await getSquareCenter(page, board, 'a2');
    const tgt = await getSquareCenter(page, board, 'a5');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(tgt.x, tgt.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(board)).toBe(0);
  });
});

// ─── S2: Opponent piece drag blocked (regression KS-291) ────────────────────

test.describe('KS-295 S2: Opponent piece drag blocked in puzzles', () => {
  test('PuzzlePage: opponent piece drag does not start', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzlePage(page);
    const board = page.locator('.board-container');

    // Black to move, board oriented as black. White pieces are opponent.
    // Try to drag white pawn from e4 (opponent's piece)
    const src = await getSquareCenter(page, board, 'e4');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.waitForTimeout(100);

    // No ghost for opponent's piece
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(board)).toBe(0);

    await page.mouse.up();
    await page.waitForTimeout(200);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(board)).toBe(0);
  });

  test('PuzzleRush: opponent piece drag does not start', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // White to move. Black pieces are opponent.
    const src = await getSquareCenter(page, board, 'e7');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.waitForTimeout(100);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(board)).toBe(0);

    await page.mouse.up();
    await page.waitForTimeout(200);

    expect(await countGhosts(page)).toBe(0);
  });
});

// ─── S3: Ghost element cleanup after impossible move ────────────────────────

test.describe('KS-295 S3: Ghost cleanup after impossible move', () => {
  test('ghost removed after drag to invalid square', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzlePage(page);
    const board = page.locator('.board-container');

    // Drag own piece to wrong square
    const src = await getSquareCenter(page, board, 'c7');
    const tgt = await getSquareCenter(page, board, 'c4');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.waitForTimeout(100);

    // Ghost present during drag
    expect(await countGhosts(page)).toBe(1);

    await page.mouse.move(tgt.x, tgt.y, { steps: 5 });

    // Ghost still present while holding
    expect(await countGhosts(page)).toBe(1);

    await page.mouse.up();
    await page.waitForTimeout(300);

    // Ghost must be removed after rejected move
    expect(await countGhosts(page)).toBe(0);
  });

  test('ghost removed after drop outside board', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzlePage(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'e7');
    const boardBox = await board.boundingBox();
    expect(boardBox).toBeTruthy();

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.waitForTimeout(100);

    expect(await countGhosts(page)).toBe(1);

    // Move outside the board
    await page.mouse.move(
      boardBox!.x + boardBox!.width + 80,
      boardBox!.y + boardBox!.height / 2,
      { steps: 5 },
    );
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(board)).toBe(0);
  });
});

// ─── S4: Opacity restored after multiple consecutive invalid moves ──────────

test.describe('KS-295 S4: Opacity after multiple invalid moves', () => {
  test('three consecutive invalid moves: no accumulated invisible pieces', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const invalidMoves = [
      { from: 'a2', to: 'a5' },
      { from: 'b2', to: 'b5' },
      { from: 'c2', to: 'c5' },
    ];

    for (const move of invalidMoves) {
      const src = await getSquareCenter(page, board, move.from);
      const tgt = await getSquareCenter(page, board, move.to);

      await page.mouse.move(src.x, src.y);
      await page.mouse.down();
      await page.waitForTimeout(100);
      await page.mouse.move(tgt.x, tgt.y, { steps: 3 });
      await page.mouse.up();
      await page.waitForTimeout(300);
    }

    // After three invalid moves: no ghosts, no invisible pieces
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(board)).toBe(0);

    // All three pieces still on their original squares
    for (const move of invalidMoves) {
      const count = await board
        .locator(`[data-square="${move.from}"] [data-piece]`)
        .count();
      expect(count).toBeGreaterThan(0);
    }
  });

  test('rapid invalid drags do not accumulate ghosts', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzlePage(page);
    const board = page.locator('.board-container');

    // Rapidly drag different own pieces to wrong squares
    const squares = ['a7', 'b7', 'c7', 'd7', 'f7', 'g7', 'h7'];
    for (const sq of squares) {
      const src = await getSquareCenter(page, board, sq);
      const tgt = await getSquareCenter(page, board, sq.replace('7', '4'));

      await page.mouse.move(src.x, src.y);
      await page.mouse.down();
      await page.mouse.move(tgt.x, tgt.y);
      await page.mouse.up();
      await page.waitForTimeout(200);
    }

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(board)).toBe(0);
  });
});

// ─── S5: Valid moves work correctly (no regression) ─────────────────────────

test.describe('KS-295 S5: Valid moves — no regression', () => {
  test('PuzzlePage: correct move e7→e5 works', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzlePage(page);
    const board = page.locator('.board-container');

    const src = await getSquareCenter(page, board, 'e7');
    const tgt = await getSquareCenter(page, board, 'e5');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(tgt.x, tgt.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(board)).toBe(0);
  });

  test('PuzzleRush: correct move e2→e4 works', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const src = await getSquareCenter(page, board, 'e2');
    const tgt = await getSquareCenter(page, board, 'e4');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(tgt.x, tgt.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(board)).toBe(0);
  });

  test('valid move after invalid move works correctly', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzlePage(page);
    const board = page.locator('.board-container');

    // Step 1: Invalid move d7→d4
    const wrongSrc = await getSquareCenter(page, board, 'd7');
    const wrongTgt = await getSquareCenter(page, board, 'd4');
    await page.mouse.move(wrongSrc.x, wrongSrc.y);
    await page.mouse.down();
    await page.mouse.move(wrongTgt.x, wrongTgt.y, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Board should be clean after invalid move
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(board)).toBe(0);

    // Step 2: Valid move e7→e5 should still work
    const validSrc = await getSquareCenter(page, board, 'e7');
    const validTgt = await getSquareCenter(page, board, 'e5');
    await page.mouse.move(validSrc.x, validSrc.y);
    await page.mouse.down();
    await page.waitForTimeout(100);

    // Ghost should appear for valid drag
    expect(await countGhosts(page)).toBe(1);

    await page.mouse.move(validTgt.x, validTgt.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Clean state after accepted move
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(board)).toBe(0);
  });
});
