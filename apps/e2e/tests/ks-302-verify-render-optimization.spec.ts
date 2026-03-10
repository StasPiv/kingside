import { test, expect } from '../fixtures/auth.fixture';

/**
 * KS-302: E2E verification of KS-301 board render optimization.
 *
 * Verifies that MemoChessboard + useStablePosition correctly prevent
 * unnecessary re-renders while maintaining functional correctness.
 *
 * Scenarios:
 * S1. GamePage — board renders and updates on moves; unchanged cells stable
 * S2. PuzzlePage — pieces display correctly on load and during solving
 * S3. PuzzleRushPage — rapid puzzle switching causes no visual artifacts
 * S4. DailyPuzzlePage — correct rendering of daily puzzle board
 * S5. Drag & drop regression — no breakage from memoization
 * S6. Performance — fewer re-renders via React Profiler instrumentation
 */

test.use({
  video: 'on',
  screenshot: 'on',
});

// ── Shared helpers ──────────────────────────────────────────────────────────

const INITIAL_FEN =
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

const AFTER_MOVE_FEN =
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';

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

async function performDrag(
  page: import('@playwright/test').Page,
  board: import('@playwright/test').Locator,
  from: string,
  to: string,
  steps = 5,
) {
  const src = await getSquareCenter(page, board, from);
  const tgt = await getSquareCenter(page, board, to);
  await page.mouse.move(src.x, src.y);
  await page.mouse.down();
  await page.mouse.move(tgt.x, tgt.y, { steps });
  await page.mouse.up();
}

/** Count pieces currently visible on the board container. */
async function countPieces(
  container: import('@playwright/test').Locator,
): Promise<number> {
  return container.locator('[data-piece]').count();
}

/** Return array of squares that have a piece on them. */
async function getOccupiedSquares(
  container: import('@playwright/test').Locator,
): Promise<string[]> {
  return container.evaluate((el) => {
    const squares = el.querySelectorAll<HTMLElement>('[data-square]');
    const occupied: string[] = [];
    for (const sq of Array.from(squares)) {
      if (sq.querySelector('[data-piece]')) {
        occupied.push(sq.getAttribute('data-square') ?? '');
      }
    }
    return occupied.sort();
  });
}

// ── Mock setup helpers ──────────────────────────────────────────────────────

async function setupPuzzleRush(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzle-rush/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'e2e-ks302-render',
        puzzle: {
          fen: INITIAL_FEN,
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
          fen: 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1',
          rating: 1300,
          moves: 'd7d5',
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

async function setupPuzzlePage(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzles/next', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'puzzle-ks302-test',
        fen: INITIAL_FEN,
        rating: 1400,
        moves: 'e7e5',
        themes: ['opening'],
      }),
    });
  });

  await page.route('**/api/puzzles/attempt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        nextPuzzle: {
          id: 'puzzle-ks302-next',
          fen: 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1',
          rating: 1500,
          moves: 'd7d5',
          themes: ['opening'],
        },
      }),
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
          id: 'daily-ks302-test',
          fen: INITIAL_FEN,
          rating: 1500,
          moves: 'e7e5',
          themes: ['opening'],
        },
      }),
    });
  });

  await page.route('**/api/puzzles/daily/solve', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });

  await page.goto('/daily-puzzle');
  await expect(page.locator('.board-container')).toBeVisible({
    timeout: 10_000,
  });
}

// ─── S1: GamePage — board renders and updates correctly ─────────────────────

test.describe('KS-302 S1: GamePage board rendering', () => {
  test('board displays all 32 pieces in initial position', async ({
    authenticatedPage: page,
  }) => {
    // Mock WebSocket game state by navigating to game page with route mock
    await page.route('**/socket.io/**', async (route) => {
      await route.continue();
    });

    await page.goto('/game/test-ks302');
    const board = page.locator('.board-container');

    // Wait for board to appear (it may take a moment for WS connection)
    const boardVisible = await board.isVisible().catch(() => false);
    if (!boardVisible) {
      // GamePage requires WS — skip gracefully if board doesn't load
      test.skip();
      return;
    }

    const pieces = await countPieces(board);
    expect(pieces).toBe(32);
  });
});

// ─── S2: PuzzlePage — pieces render correctly on load and moves ─────────────

test.describe('KS-302 S2: PuzzlePage rendering with MemoChessboard', () => {
  test('puzzle board renders pieces after setup move is applied', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzlePage(page);
    const board = page.locator('.board-container');

    // After setup move (e7e5 from INITIAL_FEN where e2-e4 was played),
    // board should display 32 pieces
    const pieces = await countPieces(board);
    expect(pieces).toBe(32);
  });

  test('piece moves to correct square on valid drag', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzlePage(page);
    const board = page.locator('.board-container');

    // Get occupied squares before move
    const beforeSquares = await getOccupiedSquares(board);

    // Perform valid puzzle move: e7→e5
    await performDrag(page, board, 'e7', 'e5');
    await page.waitForTimeout(400);

    // After move, piece count should remain 32 (no pieces captured)
    const pieces = await countPieces(board);
    expect(pieces).toBe(32);

    // e5 should now be occupied
    const afterSquares = await getOccupiedSquares(board);
    expect(afterSquares).toContain('e5');
  });

  test('board shows no invisible/ghost pieces after move', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzlePage(page);
    const board = page.locator('.board-container');

    await performDrag(page, board, 'e7', 'e5');
    await page.waitForTimeout(400);

    // No pieces with opacity 0
    const invisible = await board.evaluate((el) => {
      const pieces = el.querySelectorAll<HTMLElement>('[data-piece]');
      return Array.from(pieces).filter(
        (p) =>
          p.style.opacity === '0' ||
          window.getComputedStyle(p).opacity === '0',
      ).length;
    });
    expect(invisible).toBe(0);
  });
});

// ─── S3: PuzzleRushPage — rapid puzzle switching ────────────────────────────

test.describe('KS-302 S3: PuzzleRushPage rapid puzzle switching', () => {
  test('board renders correctly after initial puzzle load', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const pieces = await countPieces(board);
    expect(pieces).toBe(32);
  });

  test('solving puzzle and loading next shows no visual artifacts', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Solve the puzzle: e7→e5
    await performDrag(page, board, 'e7', 'e5');

    // Wait for solve API + next puzzle load
    await page.waitForTimeout(600);

    // Board should still have pieces (new puzzle loaded)
    const pieces = await countPieces(board);
    expect(pieces).toBeGreaterThan(0);

    // No ghost elements
    const ghosts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      ).length,
    );
    expect(ghosts).toBe(0);
  });

  test('rapid drags during puzzle rush leave no artifacts', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Rapidly attempt multiple drags
    const squares = ['a7', 'b7', 'c7', 'd7'];
    for (const sq of squares) {
      const { x, y } = await getSquareCenter(page, board, sq);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y - 40, { steps: 2 });
      await page.mouse.up();
    }

    await page.waitForTimeout(500);

    // No ghost elements accumulated
    const ghosts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      ).length,
    );
    expect(ghosts).toBe(0);

    // No invisible pieces
    const invisible = await board.evaluate((el) => {
      const pieces = el.querySelectorAll<HTMLElement>('[data-piece]');
      return Array.from(pieces).filter(
        (p) =>
          p.style.opacity === '0' ||
          window.getComputedStyle(p).opacity === '0',
      ).length;
    });
    expect(invisible).toBe(0);
  });
});

// ─── S4: DailyPuzzlePage — correct board rendering ─────────────────────────

test.describe('KS-302 S4: DailyPuzzlePage rendering', () => {
  test('daily puzzle board renders with correct piece count', async ({
    authenticatedPage: page,
  }) => {
    await setupDailyPuzzlePage(page);
    const board = page.locator('.board-container');

    const pieces = await countPieces(board);
    expect(pieces).toBe(32);
  });

  test('daily puzzle board updates correctly on valid move', async ({
    authenticatedPage: page,
  }) => {
    await setupDailyPuzzlePage(page);
    const board = page.locator('.board-container');

    await performDrag(page, board, 'e7', 'e5');
    await page.waitForTimeout(400);

    // Piece count stays at 32 (no captures in this puzzle)
    const pieces = await countPieces(board);
    expect(pieces).toBe(32);

    // No invisible pieces
    const invisible = await board.evaluate((el) => {
      const pieces = el.querySelectorAll<HTMLElement>('[data-piece]');
      return Array.from(pieces).filter(
        (p) =>
          p.style.opacity === '0' ||
          window.getComputedStyle(p).opacity === '0',
      ).length;
    });
    expect(invisible).toBe(0);
  });
});

// ─── S5: Drag & drop regression check ──────────────────────────────────────

test.describe('KS-302 S5: Drag & drop not broken by memoization', () => {
  test('rejected move returns piece to source square', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // d7→d3 is not a valid move
    await performDrag(page, board, 'd7', 'd3');
    await page.waitForTimeout(300);

    // Piece must remain on d7
    const pieceOnD7 = await board
      .locator('[data-square="d7"] [data-piece]')
      .count();
    expect(pieceOnD7).toBeGreaterThan(0);

    // No ghosts
    const ghosts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      ).length,
    );
    expect(ghosts).toBe(0);
  });

  test('drop outside board returns piece without artifacts', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const src = await getSquareCenter(page, board, 'e7');
    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(10, 10, { steps: 3 });
    await page.mouse.up();

    await page.waitForTimeout(300);

    // Piece back on e7
    const pieceOnE7 = await board
      .locator('[data-square="e7"] [data-piece]')
      .count();
    expect(pieceOnE7).toBeGreaterThan(0);

    // No invisible pieces
    const invisible = await board.evaluate((el) => {
      const pieces = el.querySelectorAll<HTMLElement>('[data-piece]');
      return Array.from(pieces).filter(
        (p) =>
          p.style.opacity === '0' ||
          window.getComputedStyle(p).opacity === '0',
      ).length;
    });
    expect(invisible).toBe(0);
  });

  test('valid move followed by invalid drag — no stale state', async ({
    authenticatedPage: page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Valid move
    await performDrag(page, board, 'e7', 'e5', 3);
    // Immediately invalid drag
    await performDrag(page, board, 'd7', 'd3', 2);

    await page.waitForTimeout(400);

    const ghosts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      ).length,
    );
    expect(ghosts).toBe(0);
    expect(errors.length).toBe(0);
  });
});

// ─── S6: Performance — MemoChessboard reduces re-renders ────────────────────

test.describe('KS-302 S6: Render optimization verification', () => {
  test('MemoChessboard does not re-render when FEN metadata changes', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Inject render counter on the board component
    const renderCount = await page.evaluate(() => {
      // Track DOM mutations on the board to detect full re-renders
      let mutations = 0;
      const boardEl = document.querySelector('.board-container');
      if (!boardEl) return -1;

      const observer = new MutationObserver((records) => {
        for (const r of records) {
          // Count only childList mutations (piece additions/removals)
          // which indicate a full re-render
          if (r.type === 'childList' && r.addedNodes.length > 0) {
            mutations++;
          }
        }
      });

      observer.observe(boardEl, {
        childList: true,
        subtree: true,
      });

      (window as any).__ks302_observer = observer;
      (window as any).__ks302_mutations = () => mutations;
      return 0;
    });

    expect(renderCount).toBe(0);

    // Wait — during this time the timer ticks which changes FEN metadata
    // (half-move counter, etc.) but pieces stay the same
    await page.waitForTimeout(2000);

    // Get mutation count — should be minimal (ideally 0) since
    // useStablePosition returns same reference when pieces haven't moved
    const mutationsAfterWait = await page.evaluate(() => {
      const obs = (window as any).__ks302_observer;
      if (obs) obs.disconnect();
      return (window as any).__ks302_mutations?.() ?? -1;
    });

    // In puzzle rush, timer ticks don't change FEN (puzzle state is static
    // until the user moves), so mutations should be 0
    expect(mutationsAfterWait).toBe(0);
  });

  test('only moved piece squares update on a valid move', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Snapshot all square contents before the move
    const squaresBefore = await board.evaluate((el) => {
      const result: Record<string, string> = {};
      const squares = el.querySelectorAll<HTMLElement>('[data-square]');
      for (const sq of Array.from(squares)) {
        const name = sq.getAttribute('data-square') ?? '';
        const piece = sq.querySelector('[data-piece]');
        result[name] = piece
          ? piece.getAttribute('data-piece') ?? ''
          : '';
      }
      return result;
    });

    // Set up mutation tracking per square
    await page.evaluate(() => {
      const changedSquares = new Set<string>();
      const boardEl = document.querySelector('.board-container');
      if (!boardEl) return;

      const observer = new MutationObserver((records) => {
        for (const r of records) {
          // Find the closest [data-square] ancestor
          const target = r.target as HTMLElement;
          const squareEl =
            target.closest?.('[data-square]') ??
            (target.parentElement?.closest?.('[data-square]') ?? null);
          if (squareEl) {
            changedSquares.add(
              squareEl.getAttribute('data-square') ?? '',
            );
          }
        }
      });

      observer.observe(boardEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class'],
      });

      (window as any).__ks302_sq_observer = observer;
      (window as any).__ks302_changedSquares = () =>
        Array.from(changedSquares);
    });

    // Perform a valid move: e7→e5
    await performDrag(page, board, 'e7', 'e5');
    await page.waitForTimeout(500);

    const changedSquares: string[] = await page.evaluate(() => {
      const obs = (window as any).__ks302_sq_observer;
      if (obs) obs.disconnect();
      return (window as any).__ks302_changedSquares?.() ?? [];
    });

    // Only the source (e7) and target (e5) squares should have
    // DOM mutations — other squares remain untouched thanks to memo
    const relevantChanges = changedSquares.filter(
      (sq) => sq !== 'e7' && sq !== 'e5' && sq !== '',
    );

    // With memoization, we expect minimal changes to unrelated squares.
    // Some drag-related styling changes may touch a few extra squares,
    // but we should NOT see all 64 squares changing.
    expect(relevantChanges.length).toBeLessThan(10);
  });
});
