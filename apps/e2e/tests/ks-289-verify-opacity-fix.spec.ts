import { test, expect } from '../fixtures/auth.fixture';

/**
 * KS-289: E2E verification of KS-286 fix — opacity not restored on rejected move.
 *
 * KS-286 bug: on PuzzlePage and DailyPuzzlePage, when a drag-and-drop move
 * was rejected, the piece's opacity stayed at 0 (invisible) instead of
 * being restored to 1.
 *
 * Fix: PuzzlePage and DailyPuzzlePage now use useFastDrag (like GamePage
 * and PuzzleRushPage). Added allowDragging: false in boardOptions and
 * enabled flag.
 *
 * Scenarios:
 * 1. PuzzlePage — invalid move: piece returns with opacity:1
 * 2. DailyPuzzlePage — invalid move: piece returns with opacity:1
 * 3. PuzzlePage — valid move: no regression
 * 4. DailyPuzzlePage — valid move: no regression
 * 5. Regression: GamePage and PuzzleRushPage drag-and-drop still works
 */

const puzzleFen =
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

// The expected solution: first move is the "setup" (opponent's last move),
// second move is the player's correct answer.
const puzzleMoves = 'e7e5';

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

// ─── Helpers: route mocking ─────────────────────────────────────────────────

async function setupPuzzlePage(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzles/next', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-ks289-puzzle',
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
  await expect(page.locator('.board-container')).toBeVisible({ timeout: 10_000 });
}

async function setupDailyPuzzlePage(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzles/daily', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        puzzle: {
          id: 'e2e-ks289-daily',
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
  await expect(page.locator('.board-container')).toBeVisible({ timeout: 10_000 });
}

async function setupPuzzleRush(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzle-rush/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'e2e-ks289-rush',
        puzzle: { fen: puzzleFen, rating: 1200, moves: puzzleMoves },
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
        nextPuzzle: { fen: puzzleFen, rating: 1300, moves: puzzleMoves },
      }),
    });
  });

  await page.goto('/puzzle-rush');
  await page.locator('.play-btn').click();
  await expect(page.locator('.board-container')).toBeVisible({ timeout: 10_000 });
}

// ─── S1: PuzzlePage — invalid move drag-and-drop ────────────────────────────

test.describe('KS-289 S1: PuzzlePage — invalid move opacity restored', () => {
  test('drag to wrong square: piece returns with full opacity', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzlePage(page);
    const board = page.locator('.board-container');

    // Black to move. Expected: e7e5. Try an invalid move: d7→d4
    const src = await getSquareCenter(page, board, 'd7');
    const tgt = await getSquareCenter(page, board, 'd4');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(tgt.x, tgt.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Core KS-286 check: no pieces with opacity:0
    expect(await getInvisiblePieceCount(board)).toBe(0);
    expect(await countGhosts(page)).toBe(0);

    // Piece must still exist on d7
    const pieceOnD7 = await board.locator('[data-square="d7"] [data-piece]').count();
    expect(pieceOnD7).toBeGreaterThan(0);
  });

  test('drop outside board: piece opacity restored', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzlePage(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'e7');
    const boardBox = await board.boundingBox();
    expect(boardBox).toBeTruthy();

    const outsideX = boardBox!.x + boardBox!.width + 80;
    const outsideY = boardBox!.y + boardBox!.height / 2;

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(outsideX, outsideY, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await getInvisiblePieceCount(board)).toBe(0);
    expect(await countGhosts(page)).toBe(0);
  });
});

// ─── S2: DailyPuzzlePage — invalid move drag-and-drop ──────────────────────

test.describe('KS-289 S2: DailyPuzzlePage — invalid move opacity restored', () => {
  test('drag to wrong square: piece returns with full opacity', async ({
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

    expect(await getInvisiblePieceCount(board)).toBe(0);
    expect(await countGhosts(page)).toBe(0);

    const pieceOnA7 = await board.locator('[data-square="a7"] [data-piece]').count();
    expect(pieceOnA7).toBeGreaterThan(0);
  });

  test('drop outside board: piece opacity restored', async ({
    authenticatedPage: page,
  }) => {
    await setupDailyPuzzlePage(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'e7');
    const boardBox = await board.boundingBox();
    expect(boardBox).toBeTruthy();

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(boardBox!.x - 50, src.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await getInvisiblePieceCount(board)).toBe(0);
    expect(await countGhosts(page)).toBe(0);
  });
});

// ─── S3: PuzzlePage — valid move (no regression) ───────────────────────────

test.describe('KS-289 S3: PuzzlePage — valid move works', () => {
  test('correct move e7→e5: piece moves, no invisible artifacts', async ({
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
});

// ─── S4: DailyPuzzlePage — valid move (no regression) ──────────────────────

test.describe('KS-289 S4: DailyPuzzlePage — valid move works', () => {
  test('correct move e7→e5: piece moves, no invisible artifacts', async ({
    authenticatedPage: page,
  }) => {
    await setupDailyPuzzlePage(page);
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
});

// ─── S5: Regression — GamePage and PuzzleRushPage ───────────────────────────

test.describe('KS-289 S5: Regression — PuzzleRushPage drag still works', () => {
  test('invalid move on PuzzleRush: piece opacity restored', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const src = await getSquareCenter(page, board, 'b7');
    const tgt = await getSquareCenter(page, board, 'b4');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(tgt.x, tgt.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await getInvisiblePieceCount(board)).toBe(0);
    expect(await countGhosts(page)).toBe(0);
  });

  test('valid move on PuzzleRush: no artifacts', async ({
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

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(board)).toBe(0);
  });
});
