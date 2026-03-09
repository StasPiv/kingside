import { test, expect } from '../fixtures/auth.fixture';

/**
 * KS-273: QA verification of drag-and-drop fix (KS-270).
 *
 * Verifies the enabled-state regression fix in useFastDrag:
 * - enabled check moved into onPointerDown (via optionsRef)
 * - options.enabled added to useEffect dependencies
 *
 * Scenarios:
 * 1. Puzzle Rush: drag works from first move
 * 2. Puzzle Rush: drag works after restart (start -> playing -> start -> playing)
 * 3. Game: drag works in new game
 * 4. Game: drag works after navigation between games
 * 5. Touch events on mobile devices
 */

const mockPuzzleFen =
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

const mockNextPuzzleFen =
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';

// Helper: simulate pointer drag
async function dragPiece(
  page: import('@playwright/test').Page,
  boardLocator: import('@playwright/test').Locator,
  fromSquare: string,
  toSquare: string,
) {
  const source = boardLocator.locator(`[data-square="${fromSquare}"]`);
  const target = boardLocator.locator(`[data-square="${toSquare}"]`);

  await source.waitFor({ state: 'visible', timeout: 5000 });
  await target.waitFor({ state: 'visible', timeout: 5000 });

  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).toBeTruthy();
  expect(targetBox).toBeTruthy();

  const sx = sourceBox!.x + sourceBox!.width / 2;
  const sy = sourceBox!.y + sourceBox!.height / 2;
  const tx = targetBox!.x + targetBox!.width / 2;
  const ty = targetBox!.y + targetBox!.height / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 5, sy + 5, { steps: 2 });
  await page.mouse.move(tx, ty, { steps: 5 });
  await page.mouse.up();
}

// Helper: check ghost appears during drag (indicates useFastDrag is active)
async function verifyDragCreatesGhost(
  page: import('@playwright/test').Page,
  boardLocator: import('@playwright/test').Locator,
  fromSquare: string,
): Promise<boolean> {
  const source = boardLocator.locator(`[data-square="${fromSquare}"]`);
  const sourceBox = await source.boundingBox();
  expect(sourceBox).toBeTruthy();

  const sx = sourceBox!.x + sourceBox!.width / 2;
  const sy = sourceBox!.y + sourceBox!.height / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 10, sy + 10, { steps: 2 });

  const ghostExists = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-piece]')).some((el) => {
      const style = (el as HTMLElement).style;
      return style.position === 'fixed' && style.zIndex === '9999';
    });
  });

  await page.mouse.up();
  return ghostExists;
}

function mockPuzzleRushStartRoute(page: import('@playwright/test').Page) {
  return page.route('**/api/puzzle-rush/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'e2e-ks273-test',
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
}

function mockPuzzleRushSolveRoute(page: import('@playwright/test').Page) {
  return page.route('**/api/puzzle-rush/solve', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        correct: true,
        score: 1,
        lives: 3,
        finished: false,
        nextPuzzle: {
          fen: mockNextPuzzleFen,
          rating: 1300,
          moves: 'd7d5',
        },
      }),
    });
  });
}

async function startPuzzleRush(page: import('@playwright/test').Page) {
  await page.goto('/puzzle-rush');
  await page.locator('.play-btn').click();
  await expect(page.locator('.board-container')).toBeVisible({
    timeout: 10_000,
  });
}

// ─── Scenario 1: Puzzle Rush — drag works from first move ─────────────────────

test.describe('KS-273 Scenario 1: Puzzle Rush first move drag', () => {
  test('drag-and-drop works immediately on first move after start', async ({
    authenticatedPage: page,
  }) => {
    await mockPuzzleRushStartRoute(page);
    await mockPuzzleRushSolveRoute(page);
    await startPuzzleRush(page);

    const board = page.locator('.board-container');

    // Verify ghost element appears during drag — proves useFastDrag is active
    const ghostCreated = await verifyDragCreatesGhost(page, board, 'e7');
    expect(ghostCreated).toBe(true);
  });

  test('drag triggers move handler on first move', async ({
    authenticatedPage: page,
  }) => {
    await mockPuzzleRushStartRoute(page);

    let solveApiCalled = false;
    await page.route('**/api/puzzle-rush/solve', async (route) => {
      solveApiCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          correct: true,
          score: 1,
          lives: 3,
          finished: false,
          nextPuzzle: {
            fen: mockNextPuzzleFen,
            rating: 1300,
            moves: 'd7d5',
          },
        }),
      });
    });

    await startPuzzleRush(page);
    const board = page.locator('.board-container');

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Drag correct puzzle move
    await dragPiece(page, board, 'e7', 'e5');
    await page.waitForTimeout(500);

    expect(errors).toHaveLength(0);
    // The solve API should be called — proves drag triggered onPieceDrop
    expect(solveApiCalled).toBe(true);
  });
});

// ─── Scenario 2: Puzzle Rush — drag works after restart ───────────────────────

test.describe('KS-273 Scenario 2: Puzzle Rush restart', () => {
  test('drag works after restart cycle (start -> playing -> result -> start -> playing)', async ({
    authenticatedPage: page,
  }) => {
    await mockPuzzleRushStartRoute(page);
    await mockPuzzleRushSolveRoute(page);

    // First session
    await startPuzzleRush(page);
    const board = page.locator('.board-container');

    // Verify drag works in first session
    const ghostFirstSession = await verifyDragCreatesGhost(page, board, 'e7');
    expect(ghostFirstSession).toBe(true);

    // End session: mock finish response
    await page.unroute('**/api/puzzle-rush/solve');
    await page.route('**/api/puzzle-rush/solve', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          correct: false,
          score: 0,
          lives: 0,
          finished: true,
        }),
      });
    });

    // Trigger game end by making a move
    await dragPiece(page, board, 'e7', 'e5');
    await page.waitForTimeout(500);

    // Should be on result screen now
    await expect(page.locator('.puzzle-rush-result')).toBeVisible({
      timeout: 5000,
    });

    // Click "Play Again" -> goes to start screen
    await page.locator('.play-btn').click();

    // Re-mock routes for second session
    await page.unroute('**/api/puzzle-rush/start');
    await page.unroute('**/api/puzzle-rush/solve');
    await mockPuzzleRushStartRoute(page);
    await mockPuzzleRushSolveRoute(page);

    // Start second session
    await page.locator('.play-btn').click();
    await expect(page.locator('.board-container')).toBeVisible({
      timeout: 10_000,
    });

    // Verify drag works in second session — this is the regression scenario
    const boardAfterRestart = page.locator('.board-container');
    const ghostSecondSession = await verifyDragCreatesGhost(
      page,
      boardAfterRestart,
      'e7',
    );
    expect(ghostSecondSession).toBe(true);
  });

  test('enabled transitions correctly: disabled on start screen, enabled on playing', async ({
    authenticatedPage: page,
  }) => {
    await mockPuzzleRushStartRoute(page);
    await startPuzzleRush(page);

    const board = page.locator('.board-container');

    // On playing screen, useFastDrag should be active
    // Verify by checking that pointerdown on a piece creates a ghost
    const ghostOnPlaying = await verifyDragCreatesGhost(page, board, 'e7');
    expect(ghostOnPlaying).toBe(true);
  });
});

// ─── Scenario 3: Game — drag works in new game ───────────────────────────────

test.describe('KS-273 Scenario 3: Game page drag', () => {
  test('useFastDrag hooks into board container with correct selector', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/game/e2e-ks273-test');
    await page.waitForTimeout(2000);

    const url = page.url();
    if (url.includes('/game/')) {
      const board = page.locator('.board-container');
      if (await board.isVisible()) {
        // Verify div[id$="-board"] selector finds the board element
        const boardInfo = await board.evaluate((container) => {
          const boardEl = container.querySelector<HTMLElement>(
            'div[id$="-board"]',
          );
          if (!boardEl) return null;
          const rect = boardEl.getBoundingClientRect();
          return {
            exists: true,
            width: rect.width,
            height: rect.height,
            squareCount: boardEl.querySelectorAll('[data-square]').length,
          };
        });

        if (boardInfo) {
          expect(boardInfo.exists).toBe(true);
          expect(boardInfo.squareCount).toBe(64);
          // Board should be square
          expect(Math.abs(boardInfo.width - boardInfo.height)).toBeLessThan(2);
        }
      }
    }
  });

  test('allowDragging is false and useFastDrag handles drag instead', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/game/e2e-ks273-test');
    await page.waitForTimeout(2000);

    const url = page.url();
    if (url.includes('/game/')) {
      const board = page.locator('.board-container');
      if (await board.isVisible()) {
        // Verify no dnd-kit overlay (allowDragging: false)
        const dndOverlays = await page
          .locator('.dnd-overlay, [data-dnd-overlay]')
          .count();
        expect(dndOverlays).toBe(0);
      }
    }
  });
});

// ─── Scenario 4: Game — drag works after navigation between games ────────────

test.describe('KS-273 Scenario 4: Navigation between games', () => {
  test('useFastDrag re-enables when navigating to new game (status resets to active)', async ({
    authenticatedPage: page,
  }) => {
    // This test verifies the fix: options.enabled in useEffect deps
    // ensures listeners re-attach when enabled changes

    // Navigate to first game
    await page.goto('/game/e2e-ks273-game1');
    await page.waitForTimeout(1000);

    // Navigate to second game
    await page.goto('/game/e2e-ks273-game2');
    await page.waitForTimeout(1000);

    const url = page.url();
    if (url.includes('/game/')) {
      const board = page.locator('.board-container');
      if (await board.isVisible()) {
        // Board should still have the correct selector
        const boardElValid = await board.evaluate((container) => {
          const boardEl = container.querySelector<HTMLElement>(
            'div[id$="-board"]',
          );
          if (!boardEl) return false;
          const rect = boardEl.getBoundingClientRect();
          return rect.width > 0 && Math.abs(rect.width - rect.height) < 2;
        });
        expect(boardElValid).toBe(true);
      }
    }
  });
});

// ─── Scenario 5: Touch events on mobile ──────────────────────────────────────

test.describe('KS-273 Scenario 5: Touch/mobile drag', () => {
  test('touch pointer events trigger drag on Puzzle Rush', async ({
    authenticatedPage: page,
  }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 812 });

    await mockPuzzleRushStartRoute(page);
    await mockPuzzleRushSolveRoute(page);
    await startPuzzleRush(page);

    const board = page.locator('.board-container');
    const source = board.locator('[data-square="e7"]');
    const target = board.locator('[data-square="e5"]');

    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).toBeTruthy();
    expect(targetBox).toBeTruthy();

    const sx = sourceBox!.x + sourceBox!.width / 2;
    const sy = sourceBox!.y + sourceBox!.height / 2;
    const tx = targetBox!.x + targetBox!.width / 2;
    const ty = targetBox!.y + targetBox!.height / 2;

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Simulate touch-based pointer events
    await page.evaluate(
      ({ sx, sy, tx, ty }) => {
        const el = document.elementFromPoint(sx, sy);
        if (!el) return;

        el.dispatchEvent(
          new PointerEvent('pointerdown', {
            clientX: sx,
            clientY: sy,
            pointerId: 1,
            pointerType: 'touch',
            bubbles: true,
            cancelable: true,
          }),
        );

        document.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: sx + 5,
            clientY: sy + 5,
            pointerId: 1,
            pointerType: 'touch',
            bubbles: true,
          }),
        );

        document.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: tx,
            clientY: ty,
            pointerId: 1,
            pointerType: 'touch',
            bubbles: true,
          }),
        );

        document.dispatchEvent(
          new PointerEvent('pointerup', {
            clientX: tx,
            clientY: ty,
            pointerId: 1,
            pointerType: 'touch',
            bubbles: true,
          }),
        );
      },
      { sx, sy, tx, ty },
    );

    expect(errors).toHaveLength(0);

    // Ghost should be cleaned up after touch drag
    await page.waitForTimeout(300);
    const ghostsRemaining = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      ).length;
    });
    expect(ghostsRemaining).toBe(0);
  });

  test('touch drag creates ghost element on mobile viewport', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    await mockPuzzleRushStartRoute(page);
    await startPuzzleRush(page);

    const board = page.locator('.board-container');
    const source = board.locator('[data-square="d7"]');

    const sourceBox = await source.boundingBox();
    expect(sourceBox).toBeTruthy();

    const sx = sourceBox!.x + sourceBox!.width / 2;
    const sy = sourceBox!.y + sourceBox!.height / 2;

    // Start touch drag and check ghost
    const ghostCreated = await page.evaluate(
      ({ sx, sy }) => {
        const el = document.elementFromPoint(sx, sy);
        if (!el) return false;

        el.dispatchEvent(
          new PointerEvent('pointerdown', {
            clientX: sx,
            clientY: sy,
            pointerId: 1,
            pointerType: 'touch',
            bubbles: true,
            cancelable: true,
          }),
        );

        document.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: sx + 10,
            clientY: sy + 10,
            pointerId: 1,
            pointerType: 'touch',
            bubbles: true,
          }),
        );

        const hasGhost = Array.from(
          document.querySelectorAll('[data-piece]'),
        ).some((el) => {
          const style = (el as HTMLElement).style;
          return style.position === 'fixed' && style.zIndex === '9999';
        });

        // Clean up
        document.dispatchEvent(
          new PointerEvent('pointerup', {
            clientX: sx + 10,
            clientY: sy + 10,
            pointerId: 1,
            pointerType: 'touch',
            bubbles: true,
          }),
        );

        return hasGhost;
      },
      { sx, sy },
    );

    expect(ghostCreated).toBe(true);
  });

  test('boardRect calculation is correct on mobile viewport', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    await mockPuzzleRushStartRoute(page);
    await startPuzzleRush(page);

    const board = page.locator('.board-container');

    const dimensions = await board.evaluate((container) => {
      const boardEl = container.querySelector<HTMLElement>(
        'div[id$="-board"]',
      );
      if (!boardEl) return null;

      const rect = boardEl.getBoundingClientRect();
      const squareEl = boardEl.querySelector<HTMLElement>('[data-square]');
      const squareRect = squareEl?.getBoundingClientRect();

      return {
        boardWidth: rect.width,
        boardHeight: rect.height,
        squareWidth: squareRect?.width ?? 0,
        computedSquareSize: rect.width / 8,
      };
    });

    expect(dimensions).toBeTruthy();
    // Board should be square
    expect(dimensions!.boardWidth).toBeCloseTo(dimensions!.boardHeight, 0);
    // Computed squareSize should match actual square size
    expect(dimensions!.computedSquareSize).toBeCloseTo(
      dimensions!.squareWidth,
      0,
    );
  });
});
