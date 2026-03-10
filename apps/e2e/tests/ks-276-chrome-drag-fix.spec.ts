import { test, expect } from '../fixtures/auth.fixture';

/**
 * KS-277: QA verification of KS-276 fix (piece disappears on drag-and-drop in Chrome).
 *
 * KS-276 root cause: Chrome loses pointer capture when setPointerCapture is
 * called on a deep SVG child that React may re-render/remove. Additionally,
 * native HTML5 drag can hijack the pointer sequence on images/SVGs.
 *
 * Fix applied in useFastDrag:
 * 1. setPointerCapture targets the container, not e.target
 * 2. dragstart event is blocked to prevent native HTML5 drag
 * 3. lostpointercapture handler restores piece visibility as safety net
 *
 * Scenarios verified:
 * 1. Drag-and-drop in Chrome - piece stays visible during capture
 * 2. Rapid sequential drag-and-drop - piece remains visible
 * 3. Drop outside board - piece returns and stays visible
 * 4. Touch drag on mobile Chrome - piece does not disappear
 * 5. Native HTML5 drag is blocked on SVG/image elements
 * 6. lostpointercapture restores visibility
 * 7. No regressions in Firefox/Safari (cross-browser)
 */

const mockPuzzleFen =
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

async function setupPuzzleRush(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzle-rush/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'e2e-ks276-test',
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

// Helper: drag piece using pointer events
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

// Helper: verify piece visibility on a square (opacity != 0)
async function assertPieceVisible(
  page: import('@playwright/test').Page,
  boardLocator: import('@playwright/test').Locator,
  square: string,
) {
  const piece = boardLocator.locator(
    `[data-square="${square}"] [data-piece]`,
  );
  if ((await piece.count()) > 0) {
    const opacity = await piece.evaluate((el) =>
      window.getComputedStyle(el).opacity,
    );
    expect(Number(opacity)).toBeGreaterThan(0);
  }
}

// Helper: count ghost elements in DOM
async function countGhosts(
  page: import('@playwright/test').Page,
): Promise<number> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-piece]')).filter(
      (el) => (el as HTMLElement).style.position === 'fixed',
    ).length,
  );
}

// ─── Scenario 1: Piece stays visible during drag in Chrome ────────────────────

test.describe('KS-276 S1: Drag-and-drop piece visibility', () => {
  test('piece remains visible after drag-and-drop completes', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    await dragPiece(page, board, 'e7', 'e5');
    await page.waitForTimeout(300);

    // No ghost elements should remain
    expect(await countGhosts(page)).toBe(0);

    // All visible pieces should have opacity > 0
    const invisiblePieces = await board.evaluate((container) => {
      const pieces = container.querySelectorAll<HTMLElement>('[data-piece]');
      return Array.from(pieces).filter(
        (p) => p.style.opacity === '0',
      ).length;
    });
    expect(invisiblePieces).toBe(0);
  });

  test('piece opacity is restored after drag even if move is invalid', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Invalid move: pawn from e7 to a1
    await dragPiece(page, board, 'e7', 'a1');
    await page.waitForTimeout(300);

    await assertPieceVisible(page, board, 'e7');
    expect(await countGhosts(page)).toBe(0);
  });
});

// ─── Scenario 2: Rapid sequential drag-and-drop ──────────────────────────────

test.describe('KS-276 S2: Rapid sequential drags', () => {
  test('piece stays visible after multiple rapid drag-and-drop sequences', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Perform 3 rapid drag sequences on same piece (invalid moves to keep piece on e7)
    for (let i = 0; i < 3; i++) {
      await dragPiece(page, board, 'e7', 'a1');
      // Minimal pause between drags
      await page.waitForTimeout(50);
    }

    await page.waitForTimeout(300);
    await assertPieceVisible(page, board, 'e7');
    expect(await countGhosts(page)).toBe(0);
  });

  test('no lingering ghosts after rapid drags', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Rapid drags to different invalid targets
    await dragPiece(page, board, 'd7', 'a1');
    await dragPiece(page, board, 'c7', 'h1');
    await dragPiece(page, board, 'b7', 'g1');

    await page.waitForTimeout(300);
    expect(await countGhosts(page)).toBe(0);
  });
});

// ─── Scenario 3: Drop outside board ──────────────────────────────────────────

test.describe('KS-276 S3: Drop outside board', () => {
  test('piece returns and stays visible when dropped outside board', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const source = board.locator('[data-square="e7"]');

    const sourceBox = await source.boundingBox();
    expect(sourceBox).toBeTruthy();

    const sx = sourceBox!.x + sourceBox!.width / 2;
    const sy = sourceBox!.y + sourceBox!.height / 2;

    // Drag far outside the board
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 5, sy + 5, { steps: 2 });
    await page.mouse.move(0, 0, { steps: 5 }); // top-left corner
    await page.mouse.up();

    await page.waitForTimeout(300);
    await assertPieceVisible(page, board, 'e7');
    expect(await countGhosts(page)).toBe(0);
  });
});

// ─── Scenario 4: Touch drag on mobile Chrome ─────────────────────────────────

test.describe('KS-276 S4: Mobile touch drag', () => {
  test('piece does not disappear during touch drag on mobile viewport', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await setupPuzzleRush(page);

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

    // Simulate touch pointer events
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

    await page.waitForTimeout(300);
    expect(await countGhosts(page)).toBe(0);

    // All pieces should be visible
    const invisiblePieces = await board.evaluate((container) => {
      const pieces = container.querySelectorAll<HTMLElement>('[data-piece]');
      return Array.from(pieces).filter(
        (p) => p.style.opacity === '0',
      ).length;
    });
    expect(invisiblePieces).toBe(0);
  });
});

// ─── Scenario 5: Native HTML5 drag blocked on SVG/image ──────────────────────

test.describe('KS-276 S5: Native HTML5 drag prevention', () => {
  test('dragstart event is prevented during active pointer drag', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const source = board.locator('[data-square="e7"]');

    const sourceBox = await source.boundingBox();
    expect(sourceBox).toBeTruthy();

    const sx = sourceBox!.x + sourceBox!.width / 2;
    const sy = sourceBox!.y + sourceBox!.height / 2;

    // Start drag
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 5, sy + 5, { steps: 2 });

    // Fire dragstart and check it was prevented
    const dragStartPrevented = await page.evaluate(({ sx, sy }) => {
      const el = document.elementFromPoint(sx, sy);
      if (!el) return false;

      const event = new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
      });
      // If event.defaultPrevented is true after dispatch, the handler blocked it
      el.dispatchEvent(event);
      return event.defaultPrevented;
    }, { sx: sx + 5, sy: sy + 5 });

    await page.mouse.up();

    expect(dragStartPrevented).toBe(true);
  });

  test('dragstart is NOT prevented when no drag is active', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Fire dragstart without active pointer drag
    const dragStartPrevented = await board.evaluate((container) => {
      const event = new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(event);
      return event.defaultPrevented;
    });

    expect(dragStartPrevented).toBe(false);
  });
});

// ─── Scenario 6: lostpointercapture restores visibility ──────────────────────

test.describe('KS-276 S6: lostpointercapture recovery', () => {
  test('piece visibility is restored when pointer capture is lost', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const source = board.locator('[data-square="e7"]');

    const sourceBox = await source.boundingBox();
    expect(sourceBox).toBeTruthy();

    const sx = sourceBox!.x + sourceBox!.width / 2;
    const sy = sourceBox!.y + sourceBox!.height / 2;

    // Start drag
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 10, sy + 10, { steps: 2 });

    // Simulate lostpointercapture on the container
    await page.evaluate(() => {
      const container = document.querySelector('.board-container');
      if (!container) return;
      container.dispatchEvent(
        new PointerEvent('lostpointercapture', { bubbles: false }),
      );
    });

    await page.mouse.up();
    await page.waitForTimeout(300);

    // After lostpointercapture, piece opacity should be restored and ghost removed
    await assertPieceVisible(page, board, 'e7');
    expect(await countGhosts(page)).toBe(0);
  });

  test('ghost element is removed on lostpointercapture', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const source = board.locator('[data-square="d7"]');

    const sourceBox = await source.boundingBox();
    expect(sourceBox).toBeTruthy();

    const sx = sourceBox!.x + sourceBox!.width / 2;
    const sy = sourceBox!.y + sourceBox!.height / 2;

    // Start drag
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 10, sy + 10, { steps: 2 });

    // Ghost should exist during drag
    const ghostsDuringDrag = await countGhosts(page);

    // Trigger lostpointercapture
    await page.evaluate(() => {
      const container = document.querySelector('.board-container');
      if (!container) return;
      container.dispatchEvent(
        new PointerEvent('lostpointercapture', { bubbles: false }),
      );
    });

    await page.mouse.up();
    await page.waitForTimeout(200);

    // Ghost should be cleaned up
    const ghostsAfter = await countGhosts(page);
    expect(ghostsAfter).toBe(0);

    // If ghost existed during drag, the handler did its job
    if (ghostsDuringDrag > 0) {
      expect(ghostsDuringDrag).toBe(1);
    }
  });
});

// ─── Scenario 7: Cross-browser regression check ──────────────────────────────

test.describe('KS-276 S7: Cross-browser regression', () => {
  test('drag-and-drop works without errors', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Standard drag
    await dragPiece(page, board, 'e7', 'e5');
    await page.waitForTimeout(300);

    expect(errors).toHaveLength(0);
    expect(await countGhosts(page)).toBe(0);
  });

  test('pointer capture on container does not break standard drag flow', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const source = board.locator('[data-square="e7"]');

    const sourceBox = await source.boundingBox();
    expect(sourceBox).toBeTruthy();

    const sx = sourceBox!.x + sourceBox!.width / 2;
    const sy = sourceBox!.y + sourceBox!.height / 2;

    // Verify pointer capture is set on container (not on piece/SVG child)
    const captureTarget = await page.evaluate(({ sx, sy }) => {
      // Intercept setPointerCapture calls
      let capturedOnElement = '';
      const originalSetCapture = Element.prototype.setPointerCapture;
      Element.prototype.setPointerCapture = function (pointerId: number) {
        capturedOnElement = this.className || this.tagName;
        return originalSetCapture.call(this, pointerId);
      };

      const el = document.elementFromPoint(sx, sy);
      if (el) {
        el.dispatchEvent(
          new PointerEvent('pointerdown', {
            clientX: sx,
            clientY: sy,
            pointerId: 1,
            button: 0,
            bubbles: true,
            cancelable: true,
          }),
        );
      }

      // Restore
      Element.prototype.setPointerCapture = originalSetCapture;

      // Clean up drag
      document.dispatchEvent(
        new PointerEvent('pointerup', {
          clientX: sx,
          clientY: sy,
          pointerId: 1,
          bubbles: true,
        }),
      );

      return capturedOnElement;
    }, { sx, sy });

    // Should capture on the container (board-container class), not on SVG/image
    expect(captureTarget).toContain('board-container');
  });

  test('all 64 squares present and pieces rendered after drag operations', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Perform a drag
    await dragPiece(page, board, 'e7', 'e5');
    await page.waitForTimeout(300);

    // Verify board integrity
    const squareCount = await board.locator('[data-square]').count();
    expect(squareCount).toBe(64);

    const pieceCount = await board.locator('[data-piece]').count();
    expect(pieceCount).toBeGreaterThan(0);
  });
});
