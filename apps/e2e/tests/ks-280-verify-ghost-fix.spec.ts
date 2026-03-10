import { test, expect } from '../fixtures/auth.fixture';

/**
 * KS-280: E2E verification of KS-278 fix.
 *
 * KS-278 root cause: ghost element was created with `position: fixed` but
 * without explicit `top: 0; left: 0`. Without these properties the browser
 * positions the element relative to its natural flow position, causing
 * `translate3d()` to shift it off-screen.
 *
 * Fix: added `top: 0; left: 0` to ghost element styles so translate3d
 * always starts from the viewport origin.
 *
 * Scenarios:
 * 1. Ghost element has correct CSS (position: fixed; top: 0; left: 0)
 * 2. Ghost follows cursor and stays visible during drag
 * 3. Piece does not disappear on quick click (click vs drag)
 * 4. Drag works on different viewport sizes
 * 5. Drag works with board flipped (black orientation)
 */

const mockPuzzleFen =
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

async function setupPuzzleRush(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzle-rush/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'e2e-ks280-verify',
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

// Helper: count ghost elements
async function countGhosts(
  page: import('@playwright/test').Page,
): Promise<number> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-piece]')).filter(
      (el) => (el as HTMLElement).style.position === 'fixed',
    ).length,
  );
}

// ─── Scenario 1: Ghost element has correct CSS ────────────────────────────────

test.describe('KS-280 S1: Ghost element CSS properties', () => {
  test('ghost has position:fixed with top:0 and left:0 during drag', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const source = board.locator('[data-square="e7"]');

    await source.waitFor({ state: 'visible', timeout: 5000 });
    const sourceBox = await source.boundingBox();
    expect(sourceBox).toBeTruthy();

    const sx = sourceBox!.x + sourceBox!.width / 2;
    const sy = sourceBox!.y + sourceBox!.height / 2;

    // Start drag
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 5, sy + 5, { steps: 2 });
    await page.waitForTimeout(50);

    // Inspect ghost element CSS
    const ghostStyles = await page.evaluate(() => {
      const ghosts = Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      );
      if (ghosts.length === 0) return null;
      const ghost = ghosts[0] as HTMLElement;
      return {
        position: ghost.style.position,
        top: ghost.style.top,
        left: ghost.style.left,
        transform: ghost.style.transform,
        pointerEvents: ghost.style.pointerEvents,
        zIndex: ghost.style.zIndex,
      };
    });

    expect(ghostStyles).not.toBeNull();
    expect(ghostStyles!.position).toBe('fixed');
    expect(ghostStyles!.top).toBe('0px');
    expect(ghostStyles!.left).toBe('0px');
    expect(ghostStyles!.pointerEvents).toBe('none');
    // transform should contain translate3d with non-zero values (near cursor)
    expect(ghostStyles!.transform).toMatch(/translate3d\(/);

    await page.mouse.up();
  });

  test('ghost is positioned within viewport (not off-screen)', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const source = board.locator('[data-square="e7"]');

    await source.waitFor({ state: 'visible', timeout: 5000 });
    const sourceBox = await source.boundingBox();
    expect(sourceBox).toBeTruthy();

    const sx = sourceBox!.x + sourceBox!.width / 2;
    const sy = sourceBox!.y + sourceBox!.height / 2;

    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 10, sy + 10, { steps: 3 });
    await page.waitForTimeout(50);

    // Ghost bounding box should be within viewport
    const ghostRect = await page.evaluate(() => {
      const ghosts = Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      );
      if (ghosts.length === 0) return null;
      const rect = ghosts[0].getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });

    const viewport = page.viewportSize();
    expect(ghostRect).not.toBeNull();
    // Ghost should be visible within viewport bounds (with some tolerance)
    expect(ghostRect!.right).toBeGreaterThan(0);
    expect(ghostRect!.bottom).toBeGreaterThan(0);
    expect(ghostRect!.left).toBeLessThan(viewport!.width);
    expect(ghostRect!.top).toBeLessThan(viewport!.height);

    await page.mouse.up();
  });
});

// ─── Scenario 2: Ghost follows cursor correctly ──────────────────────────────

test.describe('KS-280 S2: Ghost follows cursor', () => {
  test('ghost center stays near cursor position during drag', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const source = board.locator('[data-square="e7"]');
    const target = board.locator('[data-square="e5"]');

    await source.waitFor({ state: 'visible', timeout: 5000 });
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

    // Move to midpoint and check ghost position
    const midX = (sx + tx) / 2;
    const midY = (sy + ty) / 2;
    await page.mouse.move(midX, midY, { steps: 5 });
    await page.waitForTimeout(50);

    const ghostCenter = await page.evaluate(() => {
      const ghosts = Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      );
      if (ghosts.length === 0) return null;
      const rect = ghosts[0].getBoundingClientRect();
      return {
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2,
      };
    });

    expect(ghostCenter).not.toBeNull();
    // Ghost center should be near cursor (within square size tolerance)
    const tolerance = sourceBox!.width;
    expect(Math.abs(ghostCenter!.centerX - midX)).toBeLessThan(tolerance);
    expect(Math.abs(ghostCenter!.centerY - midY)).toBeLessThan(tolerance);

    await page.mouse.up();
  });

  test('ghost is removed after drop and no pieces invisible', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const source = board.locator('[data-square="e7"]');
    const target = board.locator('[data-square="e5"]');

    await source.waitFor({ state: 'visible', timeout: 5000 });
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
    await page.mouse.move(tx, ty, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(await countGhosts(page)).toBe(0);

    const invisiblePieces = await board.evaluate((container) => {
      const pieces = container.querySelectorAll<HTMLElement>('[data-piece]');
      return Array.from(pieces).filter(
        (p) => p.style.opacity === '0' || window.getComputedStyle(p).opacity === '0',
      ).length;
    });
    expect(invisiblePieces).toBe(0);
  });
});

// ─── Scenario 3: Quick click does not lose piece ─────────────────────────────

test.describe('KS-280 S3: Click vs drag — piece visibility', () => {
  test('quick mousedown+mouseup does not make piece invisible', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const source = board.locator('[data-square="e7"]');

    await source.waitFor({ state: 'visible', timeout: 5000 });
    const sourceBox = await source.boundingBox();
    expect(sourceBox).toBeTruthy();

    const sx = sourceBox!.x + sourceBox!.width / 2;
    const sy = sourceBox!.y + sourceBox!.height / 2;

    // Quick click — no significant mouse movement
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(200);

    expect(await countGhosts(page)).toBe(0);

    const pieceOnSource = source.locator('[data-piece]');
    const count = await pieceOnSource.count();
    expect(count).toBeGreaterThan(0);

    const opacity = await pieceOnSource.evaluate(
      (el) => window.getComputedStyle(el).opacity,
    );
    expect(Number(opacity)).toBeGreaterThan(0);
  });

  test('rapid click-click-click does not leave ghost artifacts', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const source = board.locator('[data-square="d7"]');

    await source.waitFor({ state: 'visible', timeout: 5000 });
    const sourceBox = await source.boundingBox();
    expect(sourceBox).toBeTruthy();

    const sx = sourceBox!.x + sourceBox!.width / 2;
    const sy = sourceBox!.y + sourceBox!.height / 2;

    // Rapid clicks
    for (let i = 0; i < 5; i++) {
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.up();
    }

    await page.waitForTimeout(200);
    expect(await countGhosts(page)).toBe(0);

    const invisiblePieces = await board.evaluate((container) => {
      const pieces = container.querySelectorAll<HTMLElement>('[data-piece]');
      return Array.from(pieces).filter(
        (p) => p.style.opacity === '0',
      ).length;
    });
    expect(invisiblePieces).toBe(0);
  });
});

// ─── Scenario 4: Different viewport sizes ────────────────────────────────────

test.describe('KS-280 S4: Different viewport sizes', () => {
  const viewports = [
    { name: 'mobile', width: 375, height: 812 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'desktop-large', width: 1920, height: 1080 },
  ];

  for (const vp of viewports) {
    test(`ghost stays on-screen during drag on ${vp.name} (${vp.width}x${vp.height})`, async ({
      authenticatedPage: page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await setupPuzzleRush(page);
      const board = page.locator('.board-container');
      const source = board.locator('[data-square="e7"]');

      await source.waitFor({ state: 'visible', timeout: 5000 });
      const sourceBox = await source.boundingBox();
      expect(sourceBox).toBeTruthy();

      const sx = sourceBox!.x + sourceBox!.width / 2;
      const sy = sourceBox!.y + sourceBox!.height / 2;

      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx + 10, sy + 10, { steps: 3 });
      await page.waitForTimeout(50);

      const ghostRect = await page.evaluate(() => {
        const ghosts = Array.from(document.querySelectorAll('[data-piece]')).filter(
          (el) => (el as HTMLElement).style.position === 'fixed',
        );
        if (ghosts.length === 0) return null;
        const rect = ghosts[0].getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      });

      expect(ghostRect).not.toBeNull();
      expect(ghostRect!.right).toBeGreaterThan(0);
      expect(ghostRect!.bottom).toBeGreaterThan(0);
      expect(ghostRect!.left).toBeLessThan(vp.width);
      expect(ghostRect!.top).toBeLessThan(vp.height);

      await page.mouse.up();
      await page.waitForTimeout(200);
      expect(await countGhosts(page)).toBe(0);
    });
  }
});

// ─── Scenario 5: Flipped board (black orientation) ───────────────────────────

test.describe('KS-280 S5: Flipped board (black orientation)', () => {
  test('ghost visible and follows cursor with board flipped', async ({
    authenticatedPage: page,
  }) => {
    // Use a FEN where white plays (board will be from black's perspective)
    const whiteFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    await page.route('**/api/puzzle-rush/start', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId: 'e2e-ks280-flipped',
          puzzle: {
            fen: whiteFen,
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
            fen: whiteFen,
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

    const board = page.locator('.board-container');
    const source = board.locator('[data-square="e2"]');

    await source.waitFor({ state: 'visible', timeout: 5000 });
    const sourceBox = await source.boundingBox();
    expect(sourceBox).toBeTruthy();

    const sx = sourceBox!.x + sourceBox!.width / 2;
    const sy = sourceBox!.y + sourceBox!.height / 2;

    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 10, sy - 20, { steps: 3 });
    await page.waitForTimeout(50);

    // Ghost should exist and be visible
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
        rectTop: rect.top,
        rectLeft: rect.left,
        visible: rect.right > 0 && rect.bottom > 0,
      };
    });

    expect(ghostInfo).not.toBeNull();
    expect(ghostInfo!.top).toBe('0px');
    expect(ghostInfo!.left).toBe('0px');
    expect(ghostInfo!.visible).toBe(true);

    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await countGhosts(page)).toBe(0);
  });
});
