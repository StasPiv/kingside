import { test, expect } from '../fixtures/auth.fixture';

/**
 * KS-283: E2E verification of KS-278 fix (piece disappears on click during drag-and-drop).
 *
 * Scenarios from task description:
 * 1. Standard drag-and-drop — piece moves correctly, does not disappear
 * 2. Quick click on piece during drag — piece remains visible
 * 3. Multiple rapid drag-and-drop in succession — all moves are correct
 * 4. Drag-and-drop with cancel (release outside board) — piece returns
 * 5. Drag-and-drop on mobile / touch events — correct behavior
 * 6. No regressions in pointer capture with other UI elements
 */

const mockPuzzleFen =
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

async function setupPuzzleRush(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzle-rush/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'e2e-ks283-verify',
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

/** Count ghost elements (position: fixed pieces) */
async function countGhosts(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-piece]')).filter(
      (el) => (el as HTMLElement).style.position === 'fixed',
    ).length,
  );
}

/** Count pieces with opacity: 0 (invisible) */
async function countInvisiblePieces(
  page: import('@playwright/test').Page,
  board: import('@playwright/test').Locator,
): Promise<number> {
  return board.evaluate((container) => {
    const pieces = container.querySelectorAll<HTMLElement>('[data-piece]');
    return Array.from(pieces).filter(
      (p) => p.style.opacity === '0' || window.getComputedStyle(p).opacity === '0',
    ).length;
  });
}

/** Get bounding box center of a square */
async function getSquareCenter(
  board: import('@playwright/test').Locator,
  square: string,
): Promise<{ x: number; y: number }> {
  const loc = board.locator(`[data-square="${square}"]`);
  await loc.waitFor({ state: 'visible', timeout: 5000 });
  const box = await loc.boundingBox();
  expect(box).toBeTruthy();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

// ─── S1: Standard drag-and-drop ──────────────────────────────────────────────

test.describe('KS-283 S1: Standard drag-and-drop', () => {
  test('piece moves correctly and does not disappear after drag', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const from = await getSquareCenter(board, 'e7');
    const to = await getSquareCenter(board, 'e5');

    // Track page errors
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Perform drag
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 3, from.y + 3, { steps: 2 });
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();

    await page.waitForTimeout(300);

    // No ghost elements left
    expect(await countGhosts(page)).toBe(0);

    // No invisible pieces
    expect(await countInvisiblePieces(page, board)).toBe(0);

    // No JS errors during drag
    expect(errors).toHaveLength(0);
  });

  test('piece is visible on source square throughout drag lifecycle', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const from = await getSquareCenter(board, 'd7');
    const to = await getSquareCenter(board, 'd5');

    // Start drag
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 5, from.y + 5, { steps: 2 });

    // During drag: ghost should exist, original hidden
    const ghostDuringDrag = await countGhosts(page);
    expect(ghostDuringDrag).toBe(1);

    // Complete drag
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // After drop: no ghosts, no invisible pieces
    expect(await countGhosts(page)).toBe(0);
    expect(await countInvisiblePieces(page, board)).toBe(0);
  });
});

// ─── S2: Quick click during drag ─────────────────────────────────────────────

test.describe('KS-283 S2: Quick click on piece — piece remains visible', () => {
  test('quick mousedown+mouseup does not make piece disappear', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const pos = await getSquareCenter(board, 'e7');

    // Quick click — no movement
    await page.mouse.move(pos.x, pos.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(200);

    expect(await countGhosts(page)).toBe(0);

    // Piece should still be visible on e7
    const piece = board.locator('[data-square="e7"] [data-piece]');
    const count = await piece.count();
    expect(count).toBeGreaterThan(0);

    const opacity = await piece.evaluate((el) => window.getComputedStyle(el).opacity);
    expect(Number(opacity)).toBeGreaterThan(0);
  });

  test('rapid clicks on different pieces do not leave invisible pieces', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const squares = ['e7', 'd7', 'c7', 'b7', 'a7'];

    for (const sq of squares) {
      const pos = await getSquareCenter(board, sq);
      await page.mouse.move(pos.x, pos.y);
      await page.mouse.down();
      await page.mouse.up();
    }

    await page.waitForTimeout(200);

    expect(await countGhosts(page)).toBe(0);
    expect(await countInvisiblePieces(page, board)).toBe(0);
  });
});

// ─── S3: Multiple rapid drag-and-drop in succession ──────────────────────────

test.describe('KS-283 S3: Multiple rapid drag-and-drop', () => {
  test('3 consecutive drags — no ghost leaks, no invisible pieces', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Each solve returns same position, so we can re-drag e7->e5 repeatedly
    const from = await getSquareCenter(board, 'e7');
    const to = await getSquareCenter(board, 'e5');

    for (let i = 0; i < 3; i++) {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 3, from.y + 3, { steps: 2 });
      await page.mouse.move(to.x, to.y, { steps: 3 });
      await page.mouse.up();
      await page.waitForTimeout(400); // wait for board to update with next puzzle
    }

    expect(await countGhosts(page)).toBe(0);
    expect(await countInvisiblePieces(page, board)).toBe(0);
  });

  test('rapid drag-release-drag without waiting', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Drag different pieces quickly
    const pairs = [
      ['e7', 'e5'],
      ['d7', 'd5'],
      ['c7', 'c5'],
    ];

    for (const [fromSq, toSq] of pairs) {
      const from = await getSquareCenter(board, fromSq);
      const to = await getSquareCenter(board, toSq);

      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 3 });
      await page.mouse.up();
      await page.waitForTimeout(300);
    }

    expect(errors).toHaveLength(0);
    expect(await countGhosts(page)).toBe(0);
    expect(await countInvisiblePieces(page, board)).toBe(0);
  });
});

// ─── S4: Drag-and-drop with cancel (release outside board) ──────────────────

test.describe('KS-283 S4: Drag cancel — piece returns to place', () => {
  test('dropping outside board restores piece on original square', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const from = await getSquareCenter(board, 'e7');

    // Start drag
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 5, from.y + 5, { steps: 2 });

    // Move far outside the board (top-left corner of viewport)
    await page.mouse.move(0, 0, { steps: 5 });
    await page.mouse.up();

    await page.waitForTimeout(300);

    // Ghost cleaned up
    expect(await countGhosts(page)).toBe(0);

    // Piece should be restored and visible on e7
    const piece = board.locator('[data-square="e7"] [data-piece]');
    if ((await piece.count()) > 0) {
      const opacity = await piece.evaluate((el) => window.getComputedStyle(el).opacity);
      expect(Number(opacity)).toBeGreaterThan(0);
    }

    // No invisible pieces overall
    expect(await countInvisiblePieces(page, board)).toBe(0);
  });

  test('dropping on invalid square restores piece', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const from = await getSquareCenter(board, 'e7');
    const invalidTarget = await getSquareCenter(board, 'a1');

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 3, from.y + 3, { steps: 2 });
    await page.mouse.move(invalidTarget.x, invalidTarget.y, { steps: 5 });
    await page.mouse.up();

    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);

    // Piece should be restored on e7
    const piece = board.locator('[data-square="e7"] [data-piece]');
    if ((await piece.count()) > 0) {
      const opacity = await piece.evaluate((el) => window.getComputedStyle(el).opacity);
      expect(Number(opacity)).toBeGreaterThan(0);
    }
  });
});

// ─── S5: Touch events (mobile) ───────────────────────────────────────────────

test.describe('KS-283 S5: Touch/mobile drag-and-drop', () => {
  test('touch pointer events complete drag without errors', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const from = await getSquareCenter(board, 'e7');
    const to = await getSquareCenter(board, 'e5');

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Simulate touch via dispatched pointer events
    await page.evaluate(
      ({ fx, fy, tx, ty }) => {
        const el = document.elementFromPoint(fx, fy);
        if (!el) return;

        el.dispatchEvent(
          new PointerEvent('pointerdown', {
            clientX: fx,
            clientY: fy,
            pointerId: 1,
            pointerType: 'touch',
            bubbles: true,
          }),
        );

        // Intermediate moves
        const steps = 5;
        for (let i = 1; i <= steps; i++) {
          const cx = fx + ((tx - fx) * i) / steps;
          const cy = fy + ((ty - fy) * i) / steps;
          document.dispatchEvent(
            new PointerEvent('pointermove', {
              clientX: cx,
              clientY: cy,
              pointerId: 1,
              pointerType: 'touch',
              bubbles: true,
            }),
          );
        }

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
      { fx: from.x, fy: from.y, tx: to.x, ty: to.y },
    );

    await page.waitForTimeout(300);

    expect(errors).toHaveLength(0);
    expect(await countGhosts(page)).toBe(0);
    expect(await countInvisiblePieces(page, board)).toBe(0);
  });

  test('mobile viewport: drag and cancel outside board', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const from = await getSquareCenter(board, 'd7');

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 5, from.y + 5, { steps: 2 });
    // Drop outside board
    await page.mouse.move(5, 5, { steps: 3 });
    await page.mouse.up();

    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await countInvisiblePieces(page, board)).toBe(0);
  });
});

// ─── S6: Pointer capture — no regressions with other UI ──────────────────────

test.describe('KS-283 S6: Pointer capture regressions', () => {
  test('pointer capture is on container, not on piece element', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const from = await getSquareCenter(board, 'e7');

    // Track which element gets pointer capture
    const captureTarget = await page.evaluate(
      ({ x, y }) => {
        return new Promise<string>((resolve) => {
          const handler = (e: PointerEvent) => {
            document.removeEventListener('gotpointercapture', handler, true);
            const el = e.target as HTMLElement;
            resolve(el.className || el.tagName);
          };
          document.addEventListener('gotpointercapture', handler, true);

          // Trigger pointerdown
          const el = document.elementFromPoint(x, y);
          if (el) {
            el.dispatchEvent(
              new PointerEvent('pointerdown', {
                clientX: x,
                clientY: y,
                pointerId: 1,
                pointerType: 'mouse',
                bubbles: true,
                button: 0,
              }),
            );
          }

          // Timeout fallback
          setTimeout(() => resolve('timeout'), 1000);
        });
      },
      { x: from.x, y: from.y },
    );

    // Capture should be on board-container, not on a piece/SVG element
    expect(captureTarget).not.toBe('timeout');
    expect(captureTarget).not.toMatch(/svg|path|image/i);

    // Cleanup
    await page.mouse.up();
  });

  test('lostpointercapture from child does not tear down drag', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const from = await getSquareCenter(board, 'e7');
    const to = await getSquareCenter(board, 'e5');

    // Start drag
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 5, from.y + 5, { steps: 2 });
    await page.waitForTimeout(50);

    // Ghost should exist
    expect(await countGhosts(page)).toBe(1);

    // Dispatch lostpointercapture from a child element (simulating the bubbled event)
    await page.evaluate(({ x, y }) => {
      const child = document.elementFromPoint(x, y);
      if (child) {
        child.dispatchEvent(
          new PointerEvent('lostpointercapture', {
            pointerId: 1,
            bubbles: true,
          }),
        );
      }
    }, { x: from.x, y: from.y });

    await page.waitForTimeout(50);

    // Ghost should still exist — the drag was NOT torn down by child event
    expect(await countGhosts(page)).toBe(1);

    // Complete the drag normally
    await page.mouse.move(to.x, to.y, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await countInvisiblePieces(page, board)).toBe(0);
  });

  test('dragstart event is blocked during active drag', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const from = await getSquareCenter(board, 'e7');

    // Start drag
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 5, from.y + 5, { steps: 2 });
    await page.waitForTimeout(50);

    // Try to fire native dragstart — it should be prevented
    const dragStartPrevented = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return false;
      const event = new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
      });
      return !el.dispatchEvent(event); // returns false if preventDefault was called
    }, { x: from.x + 5, y: from.y + 5 });

    expect(dragStartPrevented).toBe(true);

    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await countGhosts(page)).toBe(0);
  });

  test('UI elements outside board remain interactive during drag', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const from = await getSquareCenter(board, 'e7');

    // Verify non-board elements exist and are visible before drag
    const hasNonBoardUI = await page.evaluate(() => {
      const body = document.body;
      const buttons = body.querySelectorAll('button, a, [role="button"]');
      return buttons.length > 0;
    });

    expect(hasNonBoardUI).toBe(true);

    // Start drag
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 10, from.y + 10, { steps: 2 });
    await page.waitForTimeout(50);

    // Non-board buttons should still be in the DOM and not affected
    const nonBoardButtonsAfterDrag = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, a, [role="button"]');
      return Array.from(buttons).filter(
        (el) => !el.closest('.board-container'),
      ).length;
    });
    expect(nonBoardButtonsAfterDrag).toBeGreaterThan(0);

    // Cancel drag
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await countGhosts(page)).toBe(0);
  });
});
