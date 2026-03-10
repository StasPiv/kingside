import { test, expect } from '../fixtures/auth.fixture';

/**
 * KS-298: E2E verification of KS-296 drag-and-drop fix.
 *
 * Verifies that the deferred onPieceDrop pattern (introduced in KS-296)
 * eliminates the visual jump/flash when dropping a piece.
 *
 * Scenarios:
 * S1. Accepted move — piece appears smoothly on new square, no flicker
 * S2. Rejected move — piece returns instantly to source, no artifacts
 * S3. Rapid sequential drag-and-drop — ghost elements don't accumulate
 * S4. Cross-browser (Chromium + Firefox via Playwright projects)
 * S5. Throttled connection — deferred drop still works under latency
 */

test.use({
  video: 'on',
  screenshot: 'on',
});

const mockPuzzleFen =
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

async function setupPuzzleRush(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzle-rush/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'e2e-ks298-verify-dnd',
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

// ─── S1: Accepted move — smooth placement, no flicker ─────────────────────────

test.describe('KS-298 S1: Accepted move — no visual flicker', () => {
  test('piece lands on target square without flash or ghost remnants', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    await performDrag(page, board, 'e7', 'e5');

    // Wait for snap (80ms) + cleanup (120ms fallback) + buffer
    await page.waitForTimeout(300);

    // No ghost elements remain in DOM
    expect(await countGhosts(page)).toBe(0);
    // No invisible pieces on the board
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });

  test('snap animation precedes ghost removal (deferred pattern)', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Set up MutationObserver to capture timing
    await page.evaluate(() => {
      (window as any).__ks298_events = [];
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes' && m.attributeName === 'style') {
            const el = m.target as HTMLElement;
            if (el.style.position === 'fixed' && el.style.zIndex === '9999') {
              if (el.style.transition && el.style.transition.includes('80ms')) {
                (window as any).__ks298_events.push({
                  type: 'snap-start',
                  ts: performance.now(),
                });
              }
            }
          }
          if (m.type === 'childList') {
            for (const node of Array.from(m.removedNodes)) {
              const el = node as HTMLElement;
              if (el.style?.position === 'fixed' && el.style?.zIndex === '9999') {
                (window as any).__ks298_events.push({
                  type: 'ghost-removed',
                  ts: performance.now(),
                });
              }
            }
          }
        }
      });
      observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ['style'],
      });
      (window as any).__ks298_observer = observer;
    });

    await performDrag(page, board, 'e7', 'e5');
    await page.waitForTimeout(300);

    const events = await page.evaluate(() => {
      const obs = (window as any).__ks298_observer;
      if (obs) obs.disconnect();
      return (window as any).__ks298_events || [];
    });

    const snapStart = events.find(
      (e: { type: string }) => e.type === 'snap-start',
    );
    const ghostRemoved = events.find(
      (e: { type: string }) => e.type === 'ghost-removed',
    );

    expect(snapStart).toBeTruthy();
    expect(ghostRemoved).toBeTruthy();
    // Ghost removal must follow snap animation start
    expect(ghostRemoved!.ts).toBeGreaterThan(snapStart!.ts);
  });
});

// ─── S2: Rejected move — instant return, no artifacts ─────────────────────────

test.describe('KS-298 S2: Rejected move — clean snapback', () => {
  test('illegal move returns piece to source square', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // d7→d3 is not a legal pawn move
    await performDrag(page, board, 'd7', 'd3');
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    // Piece must remain on original square
    const pieceOnD7 = await board
      .locator('[data-square="d7"] [data-piece]')
      .count();
    expect(pieceOnD7).toBeGreaterThan(0);
  });

  test('drop outside board returns piece without artifacts', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const src = await getSquareCenter(page, board, 'e7');

    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    // Move far outside the board
    await page.mouse.move(10, 10, { steps: 3 });
    await page.mouse.up();

    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    const pieceOnE7 = await board
      .locator('[data-square="e7"] [data-piece]')
      .count();
    expect(pieceOnE7).toBeGreaterThan(0);
  });
});

// ─── S3: Rapid sequential drag-and-drop — no ghost accumulation ───────────────

test.describe('KS-298 S3: Rapid sequential drags — ghost cleanup', () => {
  test('multiple fast drags leave no ghost elements in DOM', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Rapidly drag several pawns without pausing
    const pawns = ['a7', 'b7', 'c7', 'd7', 'f7', 'g7', 'h7'];
    for (const sq of pawns) {
      const { x, y } = await getSquareCenter(page, board, sq);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y - 30, { steps: 1 });
      await page.mouse.up();
    }

    // Wait for all animations + fallback timeouts
    await page.waitForTimeout(500);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
  });

  test('valid drop then immediate invalid drag — no stale ghost', async ({
    authenticatedPage: page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    // Valid move e7→e5
    await performDrag(page, board, 'e7', 'e5', 3);

    // Immediately try invalid drag (within animation window)
    await performDrag(page, board, 'd7', 'd3', 2);

    await page.waitForTimeout(400);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);
    expect(errors.length).toBe(0);
  });
});

// ─── S4: Cross-browser — runs on both Chromium and Firefox via projects ───────

test.describe('KS-298 S4: Cross-browser verification', () => {
  test('valid drop works identically across browser engines', async ({
    authenticatedPage: page,
    browserName,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    await performDrag(page, board, 'e7', 'e5');
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    // Tag the test with browser name for reporting
    test.info().annotations.push({
      type: 'browser',
      description: browserName,
    });
  });

  test('rejected drop works identically across browser engines', async ({
    authenticatedPage: page,
    browserName,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    await performDrag(page, board, 'd7', 'd3');
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    const pieceOnD7 = await board
      .locator('[data-square="d7"] [data-piece]')
      .count();
    expect(pieceOnD7).toBeGreaterThan(0);

    test.info().annotations.push({
      type: 'browser',
      description: browserName,
    });
  });
});

// ─── S5: Throttled connection — deferred drop under latency ───────────────────

test.describe('KS-298 S5: Throttled connection', () => {
  test('deferred drop works with slow 3G throttling', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);

    // Apply network throttling via CDP (Chromium only)
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: (400 * 1024) / 8, // 400 kbps
      uploadThroughput: (400 * 1024) / 8,
      latency: 400, // 400ms RTT
    });

    const board = page.locator('.board-container');

    await performDrag(page, board, 'e7', 'e5');

    // Longer wait to account for throttling
    await page.waitForTimeout(600);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    await cdp.detach();
  });

  test('rapid drags under throttling still clean up ghosts', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: (400 * 1024) / 8,
      uploadThroughput: (400 * 1024) / 8,
      latency: 400,
    });

    const board = page.locator('.board-container');

    // Rapid drags under throttled conditions
    const pawns = ['a7', 'b7', 'c7'];
    for (const sq of pawns) {
      const { x, y } = await getSquareCenter(page, board, sq);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y - 25, { steps: 1 });
      await page.mouse.up();
    }

    await page.waitForTimeout(800);

    expect(await countGhosts(page)).toBe(0);
    expect(await getInvisiblePieceCount(page, board)).toBe(0);

    await cdp.detach();
  });
});
