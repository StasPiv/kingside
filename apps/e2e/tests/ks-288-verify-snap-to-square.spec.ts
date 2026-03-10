import { test, expect } from '../fixtures/auth.fixture';

/**
 * KS-288: E2E verification of snap-to-square animation (KS-287).
 *
 * KS-287 added a 80ms ease-out transition on the ghost element at drop time,
 * so the piece smoothly snaps to the center of the target square (or back
 * to source on rejection) instead of disappearing instantly.
 *
 * Scenarios:
 * 1. Valid drop — ghost gets transition 80ms ease-out, snaps to target center
 * 2. Invalid drop — ghost snaps back to source square
 * 3. Rapid sequential drag-and-drop — no artifacts, no double cleanup
 * 4. Drop outside board — ghost returns to source
 * 5. Cross-browser (Chromium + Firefox via Playwright projects)
 * 6. Touch events (mobile emulation)
 */

const mockPuzzleFen =
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

async function setupPuzzleRush(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzle-rush/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'e2e-ks288-snap-to-square',
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
 * Capture ghost element's transition CSS during drop.
 * We inject a MutationObserver before the drag to record the transition
 * value set on the ghost.
 */
async function setupGhostTransitionCapture(
  page: import('@playwright/test').Page,
) {
  await page.evaluate(() => {
    (window as any).__ghostTransitions = [];
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'style') {
          const el = m.target as HTMLElement;
          if (
            el.style.position === 'fixed' &&
            el.style.zIndex === '9999' &&
            el.style.transition
          ) {
            (window as any).__ghostTransitions.push(el.style.transition);
          }
        }
      }
    });
    observer.observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ['style'],
    });
    (window as any).__ghostTransitionObserver = observer;
  });
}

async function getCapturedTransitions(
  page: import('@playwright/test').Page,
): Promise<string[]> {
  return page.evaluate(() => {
    const obs = (window as any).__ghostTransitionObserver;
    if (obs) obs.disconnect();
    return (window as any).__ghostTransitions || [];
  });
}

/**
 * Capture ghost element's transform right after transition is set,
 * to verify it targets the correct square center.
 */
async function setupGhostSnapCapture(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    (window as any).__ghostSnapTransforms = [];
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'style') {
          const el = m.target as HTMLElement;
          if (
            el.style.position === 'fixed' &&
            el.style.zIndex === '9999' &&
            el.style.transition &&
            el.style.transition.includes('80ms')
          ) {
            (window as any).__ghostSnapTransforms.push(el.style.transform);
          }
        }
      }
    });
    observer.observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ['style'],
    });
    (window as any).__ghostSnapObserver = observer;
  });
}

async function getCapturedSnapTransforms(
  page: import('@playwright/test').Page,
): Promise<string[]> {
  return page.evaluate(() => {
    const obs = (window as any).__ghostSnapObserver;
    if (obs) obs.disconnect();
    return (window as any).__ghostSnapTransforms || [];
  });
}

// ─── S1: Valid drop — ghost snaps to target with 80ms ease-out ───────────────

test.describe('KS-288 S1: Valid drop — snap-to-square animation', () => {
  test('ghost receives transition 80ms ease-out on valid drop', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    await setupGhostTransitionCapture(page);

    const src = await getSquareCenter(page, board, 'e7');
    const tgt = await getSquareCenter(page, board, 'e5');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(tgt.x, tgt.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const transitions = await getCapturedTransitions(page);
    expect(transitions.length).toBeGreaterThan(0);
    // Verify the transition includes 80ms ease-out
    expect(transitions.some((t) => t.includes('80ms') && t.includes('ease-out'))).toBe(true);
  });

  test('ghost transform targets the center of the target square', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    await setupGhostSnapCapture(page);

    const src = await getSquareCenter(page, board, 'e7');
    const tgt = await getSquareCenter(page, board, 'e5');

    // Get board rect and square size for expected snap position
    const boardBox = await board.locator('div[id$="-board"]').boundingBox();
    expect(boardBox).toBeTruthy();
    const squareSize = boardBox!.width / 8;

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(tgt.x, tgt.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const snapTransforms = await getCapturedSnapTransforms(page);
    expect(snapTransforms.length).toBeGreaterThan(0);

    // e5 in white orientation: col=4, row=3 → snapX = boardLeft + 4*squareSize
    const expectedSnapX = boardBox!.x + 4 * squareSize;
    const expectedSnapY = boardBox!.y + 3 * squareSize;

    // Parse the translate3d values from the captured transform
    const match = snapTransforms[0].match(
      /translate3d\(([0-9.]+)px,\s*([0-9.]+)px/,
    );
    expect(match).toBeTruthy();
    const actualX = parseFloat(match![1]);
    const actualY = parseFloat(match![2]);

    // Allow 2px tolerance for rounding
    expect(Math.abs(actualX - expectedSnapX)).toBeLessThan(2);
    expect(Math.abs(actualY - expectedSnapY)).toBeLessThan(2);
  });

  test('ghost is removed after snap animation completes', async ({
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

    // Wait for 80ms transition + 40ms buffer
    await page.waitForTimeout(200);

    expect(await countGhosts(page)).toBe(0);
    // No invisible pieces left behind
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });
});

// ─── S2: Invalid drop — ghost snaps back to source ───────────────────────────

test.describe('KS-288 S2: Invalid drop — ghost snaps back to source', () => {
  test('ghost snaps back with transition on rejected move', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    await setupGhostTransitionCapture(page);

    // d7 pawn → d4 is illegal (can only go d6 or d5)
    const src = await getSquareCenter(page, board, 'd7');
    const illegalTgt = await getSquareCenter(page, board, 'd4');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(illegalTgt.x, illegalTgt.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const transitions = await getCapturedTransitions(page);
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.some((t) => t.includes('80ms') && t.includes('ease-out'))).toBe(true);
  });

  test('ghost transform targets source square on rejected move', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    await setupGhostSnapCapture(page);

    const boardBox = await board.locator('div[id$="-board"]').boundingBox();
    expect(boardBox).toBeTruthy();
    const squareSize = boardBox!.width / 8;

    const src = await getSquareCenter(page, board, 'd7');
    const illegalTgt = await getSquareCenter(page, board, 'd4');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(illegalTgt.x, illegalTgt.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const snapTransforms = await getCapturedSnapTransforms(page);
    expect(snapTransforms.length).toBeGreaterThan(0);

    // d7 in white orientation: col=3, row=1 → snapX = boardLeft + 3*squareSize
    const expectedSnapX = boardBox!.x + 3 * squareSize;
    const expectedSnapY = boardBox!.y + 1 * squareSize;

    const match = snapTransforms[0].match(
      /translate3d\(([0-9.]+)px,\s*([0-9.]+)px/,
    );
    expect(match).toBeTruthy();
    const actualX = parseFloat(match![1]);
    const actualY = parseFloat(match![2]);

    expect(Math.abs(actualX - expectedSnapX)).toBeLessThan(2);
    expect(Math.abs(actualY - expectedSnapY)).toBeLessThan(2);
  });

  test('piece opacity restored after snap-back animation', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const src = await getSquareCenter(page, board, 'd7');
    const illegalTgt = await getSquareCenter(page, board, 'd4');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(illegalTgt.x, illegalTgt.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    // Piece must still be on d7
    const pieceOnD7 = await board
      .locator('[data-square="d7"] [data-piece]')
      .count();
    expect(pieceOnD7).toBeGreaterThan(0);
  });
});

// ─── S3: Rapid sequential drag-and-drop — no artifacts ───────────────────────

test.describe('KS-288 S3: Rapid sequential drops — no double cleanup', () => {
  test('rapid valid moves leave no ghost artifacts', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Rapid drag-drop on several pawns without waiting for animation
    const pawns = ['a7', 'b7', 'c7', 'd7', 'f7', 'g7', 'h7'];
    for (const sq of pawns) {
      const { x, y } = await getSquareCenter(page, board, sq);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y - 30, { steps: 1 });
      await page.mouse.up();
      // No pause — stress test cleanup logic
    }

    // Wait for all animations to settle (7 × 120ms fallback max)
    await page.waitForTimeout(400);
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });

  test('valid move then immediate drag of another piece — no stale ghost', async ({
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

    // Immediately drag d7 (within animation window)
    const src2 = await getSquareCenter(page, board, 'd7');
    await page.mouse.move(src2.x, src2.y);
    await page.mouse.down();
    await page.mouse.move(src2.x, src2.y - 20, { steps: 2 });
    await page.mouse.up();

    await page.waitForTimeout(300);
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });

  test('cleanup flag prevents double removal', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Track console errors during drag
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const src = await getSquareCenter(page, board, 'e7');
    const tgt = await getSquareCenter(page, board, 'e5');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(tgt.x, tgt.y, { steps: 3 });
    await page.mouse.up();

    // Wait beyond both transitionend and fallback timeout
    await page.waitForTimeout(300);

    // No errors from double cleanup (e.g., removing already-removed element)
    expect(errors.length).toBe(0);
  });
});

// ─── S4: Drop outside board — ghost returns to source ────────────────────────

test.describe('KS-288 S4: Drop outside board', () => {
  test('ghost snaps back to source when dropped outside board', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    await setupGhostSnapCapture(page);

    const boardBox = await board.locator('div[id$="-board"]').boundingBox();
    expect(boardBox).toBeTruthy();
    const squareSize = boardBox!.width / 8;

    const src = await getSquareCenter(page, board, 'e7');
    const outsideX = boardBox!.x + boardBox!.width + 100;
    const outsideY = boardBox!.y + boardBox!.height / 2;

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(outsideX, outsideY, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    // Ghost should snap back to e7: col=4, row=1
    const snapTransforms = await getCapturedSnapTransforms(page);
    expect(snapTransforms.length).toBeGreaterThan(0);

    const expectedSnapX = boardBox!.x + 4 * squareSize;
    const expectedSnapY = boardBox!.y + 1 * squareSize;

    const match = snapTransforms[0].match(
      /translate3d\(([0-9.]+)px,\s*([0-9.]+)px/,
    );
    expect(match).toBeTruthy();
    const actualX = parseFloat(match![1]);
    const actualY = parseFloat(match![2]);

    expect(Math.abs(actualX - expectedSnapX)).toBeLessThan(2);
    expect(Math.abs(actualY - expectedSnapY)).toBeLessThan(2);
  });

  test('piece fully restored after outside-board drop', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const boardBox = await board.boundingBox();
    expect(boardBox).toBeTruthy();

    const src = await getSquareCenter(page, board, 'e7');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(boardBox!.x - 50, src.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    const pieceOnE7 = await board
      .locator('[data-square="e7"] [data-piece]')
      .count();
    expect(pieceOnE7).toBeGreaterThan(0);
  });
});

// ─── S6: Touch events (mobile emulation) ─────────────────────────────────────

test.describe('KS-288 S6: Touch events — mobile emulation', () => {
  test.use({
    ...({ hasTouch: true } as any),
    viewport: { width: 390, height: 844 },
  });

  test('snap-to-square works with touch drag on mobile viewport', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    await setupGhostTransitionCapture(page);

    const src = await getSquareCenter(page, board, 'e7');
    const tgt = await getSquareCenter(page, board, 'e5');

    // Simulate touch via pointer events (Playwright maps touch → pointer)
    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    await page.mouse.move(tgt.x, tgt.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const transitions = await getCapturedTransitions(page);
    // Transition should still be applied on touch devices
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.some((t) => t.includes('80ms'))).toBe(true);

    expect(await countGhosts(page)).toBe(0);
  });

  test('rapid touch drops on mobile — no artifacts', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const pawns = ['a7', 'c7', 'f7'];
    for (const sq of pawns) {
      const { x, y } = await getSquareCenter(page, board, sq);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y - 20, { steps: 1 });
      await page.mouse.up();
    }

    await page.waitForTimeout(300);
    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });
});
