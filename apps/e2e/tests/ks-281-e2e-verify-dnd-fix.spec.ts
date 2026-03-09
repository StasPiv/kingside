import { test, expect } from '../fixtures/auth.fixture';

/**
 * KS-281: E2E verification of KS-278 drag-and-drop fix.
 *
 * KS-278 bug: piece disappears when clicking during drag-and-drop because
 * ghost element was created without `top: 0; left: 0`, causing translate3d
 * to shift it off-screen.
 *
 * Fix applied in this revision:
 * - Source squares changed to user's pieces (white: a2-h2, a1-h1)
 *   to avoid vacuous truth (dragging from empty squares).
 * - Ghost existence is asserted BEFORE release (not only after).
 * - Conditional checks (if snapInfo) replaced with strict expects.
 *
 * Scenarios:
 * 1. Drag-and-drop piece — piece does not disappear on press
 * 2. Ghost element follows cursor correctly during drag
 * 3. Piece lands on target square after drop
 * 4. Different viewport sizes
 * 5. Rapid sequential drag-and-drop
 * 6. Regression: original bug no longer reproduces
 * 7. Smooth release verification — piece drop is not abrupt
 */

// Configure all tests in this file to capture video and screenshots
test.use({
  video: 'on',
  screenshot: 'on',
});

// White to move — user plays as white, pieces on ranks 1-2
const mockPuzzleFen =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

async function setupPuzzleRush(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzle-rush/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'e2e-ks281-verify',
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

/**
 * Assert that a ghost element (position:fixed) exists on the page.
 * Returns the ghost's bounding rect for further checks.
 */
async function expectGhostExists(
  page: import('@playwright/test').Page,
): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const ghostRect = await page.evaluate(() => {
    const ghosts = Array.from(document.querySelectorAll('[data-piece]')).filter(
      (el) => (el as HTMLElement).style.position === 'fixed',
    );
    if (ghosts.length === 0) return null;
    const rect = ghosts[0].getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  });
  expect(ghostRect, 'Ghost element must exist during drag').not.toBeNull();
  return ghostRect!;
}

// ─── S1: Piece does not disappear on press ───────────────────────────────────

test.describe('KS-281 S1: Piece does not disappear on press', () => {
  test('piece stays visible after mousedown on it', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const { x, y } = await getSquareCenter(page, board, 'e2');

    // Screenshot: board before any interaction
    await page.screenshot({ path: 'test-results/ks281-s1-01-before-drag.png', fullPage: false });

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(100);

    // Screenshot: ghost visible after mousedown
    await page.screenshot({ path: 'test-results/ks281-s1-02-mousedown-ghost.png', fullPage: false });

    // Ghost MUST exist after mousedown on a piece (not vacuous)
    const ghostRect = await expectGhostExists(page);
    expect(ghostRect.right).toBeGreaterThan(0);
    expect(ghostRect.bottom).toBeGreaterThan(0);

    await page.mouse.up();
    await page.waitForTimeout(200);

    // Screenshot: board after release — piece should be visible
    await page.screenshot({ path: 'test-results/ks281-s1-03-after-release.png', fullPage: false });

    // After release: no ghosts, no invisible pieces
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });

  test('piece visible after mousedown+mouseup (click) without movement', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const { x, y } = await getSquareCenter(page, board, 'd2');

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(200);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    // Piece should still be present on the square
    const pieceCount = await board.locator('[data-square="d2"] [data-piece]').count();
    expect(pieceCount).toBeGreaterThan(0);
  });
});

// ─── S2: Ghost follows cursor during drag ────────────────────────────────────

test.describe('KS-281 S2: Ghost follows cursor during drag', () => {
  test('ghost element tracks cursor position', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'e2');
    const tgt = await getSquareCenter(page, board, 'e4');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();

    // Move through several points and verify ghost follows
    const checkpoints = [
      { x: src.x, y: src.y - 20 },
      { x: (src.x + tgt.x) / 2, y: (src.y + tgt.y) / 2 },
      { x: tgt.x, y: tgt.y },
    ];

    for (const cp of checkpoints) {
      await page.mouse.move(cp.x, cp.y, { steps: 3 });
      await page.waitForTimeout(30);

      const ghostCenter = await page.evaluate(() => {
        const ghosts = Array.from(document.querySelectorAll('[data-piece]')).filter(
          (el) => (el as HTMLElement).style.position === 'fixed',
        );
        if (ghosts.length === 0) return null;
        const rect = ghosts[0].getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });

      expect(ghostCenter, 'Ghost must exist at each checkpoint during drag').not.toBeNull();
      // Ghost center should be within one square-width of cursor
      const squareBox = await board.locator('[data-square="e2"]').boundingBox();
      const tolerance = squareBox!.width;
      expect(Math.abs(ghostCenter!.x - cp.x)).toBeLessThan(tolerance);
      expect(Math.abs(ghostCenter!.y - cp.y)).toBeLessThan(tolerance);
    }

    await page.mouse.up();
  });

  test('ghost has correct CSS: position fixed, top 0, left 0', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const { x, y } = await getSquareCenter(page, board, 'e2');

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 5, y + 5, { steps: 2 });
    await page.waitForTimeout(50);

    const styles = await page.evaluate(() => {
      const ghosts = Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      );
      if (ghosts.length === 0) return null;
      const g = ghosts[0] as HTMLElement;
      return {
        position: g.style.position,
        top: g.style.top,
        left: g.style.left,
        pointerEvents: g.style.pointerEvents,
        transform: g.style.transform,
      };
    });

    expect(styles, 'Ghost must exist with correct CSS during drag').not.toBeNull();
    expect(styles!.position).toBe('fixed');
    expect(styles!.top).toBe('0px');
    expect(styles!.left).toBe('0px');
    expect(styles!.pointerEvents).toBe('none');
    expect(styles!.transform).toMatch(/translate3d\(/);

    await page.mouse.up();
  });
});

// ─── S3: Piece lands on target square after drop ─────────────────────────────

test.describe('KS-281 S3: Piece lands on target square after drop', () => {
  test('drag e2->e4: ghost exists during drag, removed after drop', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'e2');
    const tgt = await getSquareCenter(page, board, 'e4');

    await page.screenshot({ path: 'test-results/ks281-s3-01-before-drag.png', fullPage: false });

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.screenshot({ path: 'test-results/ks281-s3-02-drag-start.png', fullPage: false });

    await page.mouse.move(tgt.x, tgt.y, { steps: 5 });
    await page.screenshot({ path: 'test-results/ks281-s3-03-drag-mid.png', fullPage: false });

    // Ghost MUST exist before release
    await expectGhostExists(page);

    await page.mouse.up();
    await page.waitForTimeout(300);

    await page.screenshot({ path: 'test-results/ks281-s3-04-after-drop.png', fullPage: false });

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });

  test('invalid drop: piece returns to source, remains visible', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'e2');
    // Drop outside the board
    const boardBox = await board.boundingBox();
    expect(boardBox).toBeTruthy();
    const outsideX = boardBox!.x + boardBox!.width + 50;
    const outsideY = boardBox!.y + boardBox!.height / 2;

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(outsideX, outsideY, { steps: 5 });

    // Ghost MUST exist before release
    await expectGhostExists(page);

    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    // Piece should still be on e2
    const pieceOnE2 = await board.locator('[data-square="e2"] [data-piece]').count();
    expect(pieceOnE2).toBeGreaterThan(0);
  });
});

// ─── S4: Different viewport sizes ────────────────────────────────────────────

test.describe('KS-281 S4: Different viewport sizes', () => {
  const viewports = [
    { name: 'mobile-portrait', width: 375, height: 812 },
    { name: 'tablet-landscape', width: 1024, height: 768 },
    { name: 'desktop-hd', width: 1920, height: 1080 },
    { name: 'small-square', width: 500, height: 500 },
  ];

  for (const vp of viewports) {
    test(`drag-and-drop works on ${vp.name} (${vp.width}x${vp.height})`, async ({
      authenticatedPage: page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await setupPuzzleRush(page);
      const board = page.locator('.board-container');
      const src = await getSquareCenter(page, board, 'e2');

      await page.mouse.move(src.x, src.y);
      await page.mouse.down();
      await page.mouse.move(src.x + 10, src.y - 10, { steps: 3 });
      await page.waitForTimeout(50);

      // Ghost MUST exist during drag (strict, no vacuous pass)
      const ghostRect = await expectGhostExists(page);
      expect(ghostRect.right).toBeGreaterThan(0);
      expect(ghostRect.bottom).toBeGreaterThan(0);
      expect(ghostRect.left).toBeLessThan(vp.width);
      expect(ghostRect.top).toBeLessThan(vp.height);

      await page.mouse.up();
      await page.waitForTimeout(200);
      expect(await countGhosts(page)).toBe(0);
      expect(await getInvisiblePieceCount(page, board)).toBe(0);
    });
  }
});

// ─── S5: Rapid sequential drag-and-drop ──────────────────────────────────────

test.describe('KS-281 S5: Rapid sequential drag-and-drop', () => {
  test('multiple rapid drags leave no ghost artifacts', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Use squares with user's pieces (white pawns on rank 2)
    const squares = ['e2', 'd2', 'c2', 'b2', 'a2'];
    for (const sq of squares) {
      const { x, y } = await getSquareCenter(page, board, sq);

      // Quick drag gesture (down -> small move -> up)
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 5, y - 5, { steps: 1 });
      await page.mouse.up();
    }

    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });

  test('rapid click-drag-click-drag sequence is clean', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Alternate between click and drag on same piece (white pawn e2)
    const { x, y } = await getSquareCenter(page, board, 'e2');
    const tgt = await getSquareCenter(page, board, 'e3');

    for (let i = 0; i < 3; i++) {
      // Click (no move)
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(50);

      // Short drag and release
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(tgt.x, tgt.y, { steps: 2 });
      await page.mouse.up();
      await page.waitForTimeout(50);
    }

    await page.waitForTimeout(300);
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });
});

// ─── S6: Regression — original KS-278 bug no longer reproduces ───────────────

test.describe('KS-281 S6: Regression verification (KS-278)', () => {
  test('ghost translate3d positions from viewport origin, not natural flow', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const { x, y } = await getSquareCenter(page, board, 'e2');

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 10, y + 10, { steps: 2 });
    await page.waitForTimeout(50);

    // Parse translate3d values from ghost transform
    const result = await page.evaluate(() => {
      const ghosts = Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      );
      if (ghosts.length === 0) return null;
      const ghost = ghosts[0] as HTMLElement;
      const transform = ghost.style.transform;
      const match = transform.match(/translate3d\(([^,]+)px,\s*([^,]+)px/);
      if (!match) return null;
      const rect = ghost.getBoundingClientRect();
      return {
        top: ghost.style.top,
        left: ghost.style.left,
        translateX: parseFloat(match[1]),
        translateY: parseFloat(match[2]),
        rectLeft: rect.left,
        rectTop: rect.top,
        rectRight: rect.right,
        rectBottom: rect.bottom,
      };
    });

    expect(result, 'Ghost with translate3d must exist during drag').not.toBeNull();
    // Key regression check: top and left must be 0 so translate3d works from origin
    expect(result!.top).toBe('0px');
    expect(result!.left).toBe('0px');
    // translate3d values should be reasonable (near cursor, not off-screen negative)
    expect(result!.translateX).toBeGreaterThan(-50);
    expect(result!.translateY).toBeGreaterThan(-50);
    // Ghost bounding rect must be on screen
    expect(result!.rectRight).toBeGreaterThan(0);
    expect(result!.rectBottom).toBeGreaterThan(0);

    await page.mouse.up();
  });

  test('piece never becomes permanently invisible after any drag interaction', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Simulate the exact scenario from KS-278: press on piece during drag state
    const { x, y } = await getSquareCenter(page, board, 'e2');

    // Normal drag
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 20, y - 20, { steps: 3 });

    // Ghost MUST exist during drag
    await expectGhostExists(page);

    await page.mouse.up();
    await page.waitForTimeout(200);

    // Immediately press same square again
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(50);
    await page.mouse.up();
    await page.waitForTimeout(200);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });

  test('drag on flipped board (black orientation) — ghost visible', async ({
    authenticatedPage: page,
  }) => {
    // Black to move — user plays as black, pieces on ranks 7-8
    const blackFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

    await page.route('**/api/puzzle-rush/start', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId: 'e2e-ks281-flipped',
          puzzle: { fen: blackFen, rating: 1200, moves: 'e7e5' },
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
          nextPuzzle: { fen: blackFen, rating: 1300, moves: 'e7e5' },
        }),
      });
    });

    await page.goto('/puzzle-rush');
    await page.locator('.play-btn').click();
    await expect(page.locator('.board-container')).toBeVisible({ timeout: 10_000 });

    const board = page.locator('.board-container');
    // Black pieces on rank 7 — drag a7 pawn (guaranteed present)
    const { x, y } = await getSquareCenter(page, board, 'a7');

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 10, y - 20, { steps: 3 });
    await page.waitForTimeout(50);

    const ghostInfo = await page.evaluate(() => {
      const ghosts = Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      );
      if (ghosts.length === 0) return null;
      const ghost = ghosts[0] as HTMLElement;
      const rect = ghost.getBoundingClientRect();
      return {
        top: ghost.style.top,
        left: ghost.style.left,
        visible: rect.right > 0 && rect.bottom > 0,
      };
    });

    expect(ghostInfo, 'Ghost must exist on flipped board drag').not.toBeNull();
    expect(ghostInfo!.top).toBe('0px');
    expect(ghostInfo!.left).toBe('0px');
    expect(ghostInfo!.visible).toBe(true);

    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await countGhosts(page)).toBe(0);
  });
});

// ─── S7: Smooth drop snap-animation verification ─────────────────────────────

test.describe('KS-281 S7: Smooth drop snap-animation', () => {
  test('valid drop: ghost gets CSS transition 100ms ease-out and snaps to target square', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'e2');
    const tgt = await getSquareCenter(page, board, 'e4');

    await page.screenshot({ path: 'test-results/ks281-s7-01-before.png', fullPage: false });

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(tgt.x, tgt.y, { steps: 10 });
    await page.waitForTimeout(50);

    // Ghost MUST exist before release
    await expectGhostExists(page);

    await page.screenshot({ path: 'test-results/ks281-s7-02-before-release.png', fullPage: false });

    // Release and immediately check ghost snap-animation CSS
    await page.mouse.up();

    // Ghost should still exist briefly with transition applied
    const snapInfo = await page.evaluate(() => {
      const ghosts = Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      );
      if (ghosts.length === 0) return null;
      const g = ghosts[0] as HTMLElement;
      return {
        transition: g.style.transition,
        transform: g.style.transform,
      };
    });

    await page.screenshot({ path: 'test-results/ks281-s7-03-after-release-immediate.png', fullPage: false });

    // Strict check: ghost MUST be caught with transition (no vacuous pass)
    expect(snapInfo, 'Ghost with snap transition must exist immediately after release').not.toBeNull();
    expect(snapInfo!.transition).toContain('100ms');
    expect(snapInfo!.transition).toContain('ease-out');
    expect(snapInfo!.transform).toMatch(/translate3d\(/);

    // Wait for animation to finish (100ms transition + 50ms margin)
    await page.waitForTimeout(200);

    await page.screenshot({ path: 'test-results/ks281-s7-04-after-animation.png', fullPage: false });

    // After animation: ghost removed, no invisible pieces
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });

  test('invalid drop: ghost snaps back to source square', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'e2');

    // Get source square bounding box for later comparison
    const srcBox = await board.locator('[data-square="e2"]').boundingBox();
    expect(srcBox).toBeTruthy();

    // Drop outside the board
    const boardBox = await board.boundingBox();
    expect(boardBox).toBeTruthy();
    const outsideX = boardBox!.x + boardBox!.width + 50;
    const outsideY = boardBox!.y + boardBox!.height / 2;

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(outsideX, outsideY, { steps: 5 });

    // Ghost MUST exist before release
    await expectGhostExists(page);

    await page.screenshot({ path: 'test-results/ks281-s7-05-invalid-before-release.png', fullPage: false });

    // Release outside board
    await page.mouse.up();

    // Immediately check ghost snap-back animation
    const snapBackInfo = await page.evaluate(() => {
      const ghosts = Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      );
      if (ghosts.length === 0) return null;
      const g = ghosts[0] as HTMLElement;
      const match = g.style.transform.match(/translate3d\(([^,]+)px,\s*([^,]+)px/);
      return {
        transition: g.style.transition,
        targetX: match ? parseFloat(match[1]) : null,
        targetY: match ? parseFloat(match[2]) : null,
      };
    });

    await page.screenshot({ path: 'test-results/ks281-s7-06-invalid-after-release.png', fullPage: false });

    // Strict check: ghost MUST be caught with snap-back transition
    expect(snapBackInfo, 'Ghost with snap-back transition must exist after invalid drop').not.toBeNull();
    expect(snapBackInfo!.transition).toContain('100ms');
    expect(snapBackInfo!.transition).toContain('ease-out');
    // Ghost should be animating back toward source square position
    expect(snapBackInfo!.targetX).not.toBeNull();
    expect(snapBackInfo!.targetX!).toBeGreaterThan(-50);
    expect(snapBackInfo!.targetY).not.toBeNull();
    expect(snapBackInfo!.targetY!).toBeGreaterThan(-50);

    await page.waitForTimeout(200);

    // After animation: ghost removed, no invisible pieces
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });

  test('no flash on accepted move: original piece stays hidden during transition', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const src = await getSquareCenter(page, board, 'e2');
    const tgt = await getSquareCenter(page, board, 'e4');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(tgt.x, tgt.y, { steps: 5 });

    // Ghost MUST exist before release
    await expectGhostExists(page);

    // Release (valid move e2->e4)
    await page.mouse.up();

    // Check immediately: original piece at source should NOT have opacity restored
    // (to prevent flash). The ghost animates to target and is then removed.
    const flashCheck = await page.evaluate(() => {
      // Find piece elements on e2 (source square) with opacity explicitly set
      const e2Square = document.querySelector('[data-square="e2"]');
      if (!e2Square) return { sourcePieces: 0, hasFlash: false };
      const pieces = e2Square.querySelectorAll<HTMLElement>('[data-piece]');
      const visiblePieces = Array.from(pieces).filter(
        (p) => p.style.opacity !== '0' && window.getComputedStyle(p).opacity !== '0',
      );
      // Also check if any ghost still exists with transition
      const ghosts = Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      );
      return {
        sourcePieces: pieces.length,
        visibleSourcePieces: visiblePieces.length,
        ghostCount: ghosts.length,
        hasFlash: visiblePieces.length > 0 && ghosts.length > 0,
      };
    });

    await page.screenshot({ path: 'test-results/ks281-s7-07-no-flash-check.png', fullPage: false });

    // After accepted move, board re-renders with new FEN — if the piece
    // was still at e2 during transition, it should have opacity: 0 (no flash)
    expect(flashCheck.hasFlash).toBe(false);

    await page.waitForTimeout(200);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });

  test('rapid drag-release cycles: no ghost leaks or flash', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const { x, y } = await getSquareCenter(page, board, 'e2');

    for (let i = 0; i < 3; i++) {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 20, y - 30, { steps: 3 });

      // Ghost MUST exist during each drag cycle
      await expectGhostExists(page);

      await page.screenshot({
        path: `test-results/ks281-s7-rapid-${i + 1}-dragging.png`,
        fullPage: false,
      });
      await page.mouse.up();
      // Wait for snap animation to complete
      await page.waitForTimeout(200);
      await page.screenshot({
        path: `test-results/ks281-s7-rapid-${i + 1}-released.png`,
        fullPage: false,
      });
    }

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });
});
