import { test, expect } from '../fixtures/auth.fixture';
import path from 'path';

/**
 * KS-279: Screenshots of drag-and-drop piece behavior (KS-278).
 *
 * Captures screenshots at 3 key moments:
 * 1. mousedown — piece should be visible on the source square
 * 2. during drag — ghost element should follow cursor between squares
 * 3. mouseup — piece should land on the target square
 *
 * Known bug (KS-278): piece disappears on mousedown, invisible during drag,
 * reappears on mouseup.
 *
 * Screenshots are saved to apps/e2e/screenshots/ks-279/
 */

const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots', 'ks-279');

const mockPuzzleFen =
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

async function setupPuzzleRush(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzle-rush/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'e2e-ks279-screenshots',
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

test.describe('KS-279: Drag-and-drop screenshots', () => {
  test('capture piece visibility at mousedown, during drag, and at mouseup', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const source = board.locator('[data-square="e7"]');
    const target = board.locator('[data-square="e5"]');

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

    // ─── Screenshot 1: mousedown — piece should be visible on source square ───
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    // Small move to trigger drag activation
    await page.mouse.move(sx + 2, sy + 2, { steps: 2 });
    await page.waitForTimeout(100);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '01-mousedown-piece-on-source.png'),
      fullPage: false,
    });

    // Check piece visibility at mousedown
    const pieceVisibleAtMousedown = await board.evaluate((container) => {
      const pieces = container.querySelectorAll<HTMLElement>('[data-piece]');
      const invisible = Array.from(pieces).filter(
        (p) => p.style.opacity === '0' || window.getComputedStyle(p).opacity === '0',
      );
      return { total: pieces.length, invisible: invisible.length };
    });

    // ─── Screenshot 2: during drag — piece/ghost should follow cursor ─────────
    // Move halfway between source and target
    const midX = (sx + tx) / 2;
    const midY = (sy + ty) / 2;
    await page.mouse.move(midX, midY, { steps: 5 });
    await page.waitForTimeout(100);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '02-dragging-piece-between-squares.png'),
      fullPage: false,
    });

    // Check ghost element exists during drag
    const ghostDuringDrag = await page.evaluate(() => {
      const ghosts = Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      );
      return {
        count: ghosts.length,
        positions: ghosts.map((g) => ({
          left: (g as HTMLElement).style.left,
          top: (g as HTMLElement).style.top,
        })),
      };
    });

    // ─── Screenshot 3: mouseup — piece should land on target square ───────────
    await page.mouse.move(tx, ty, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '03-mouseup-piece-on-target.png'),
      fullPage: false,
    });

    // Check final state: no ghost, no invisible pieces
    const finalState = await board.evaluate((container) => {
      const pieces = container.querySelectorAll<HTMLElement>('[data-piece]');
      const invisible = Array.from(pieces).filter(
        (p) => p.style.opacity === '0' || window.getComputedStyle(p).opacity === '0',
      );
      const ghosts = Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      );
      return {
        totalPieces: pieces.length,
        invisiblePieces: invisible.length,
        ghostCount: ghosts.length,
      };
    });

    // Log observations for QA report
    console.log('=== KS-279 Drag-and-Drop Screenshot Report ===');
    console.log(`Mousedown: ${pieceVisibleAtMousedown.total} pieces, ${pieceVisibleAtMousedown.invisible} invisible`);
    console.log(`During drag: ${ghostDuringDrag.count} ghost element(s)`);
    console.log(`After drop: ${finalState.totalPieces} pieces, ${finalState.invisiblePieces} invisible, ${finalState.ghostCount} ghosts`);

    // Assertions documenting expected vs actual behavior
    // After mouseup: no ghosts should remain
    expect(finalState.ghostCount).toBe(0);
    // After mouseup: no pieces should be invisible
    expect(finalState.invisiblePieces).toBe(0);
  });

  test('capture zoomed screenshot of source square during mousedown', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');
    const source = board.locator('[data-square="e7"]');

    await source.waitFor({ state: 'visible', timeout: 5000 });

    // Screenshot of just the source square before interaction
    await source.screenshot({
      path: path.join(SCREENSHOT_DIR, '04-source-square-before-mousedown.png'),
    });

    const sourceBox = await source.boundingBox();
    expect(sourceBox).toBeTruthy();

    const sx = sourceBox!.x + sourceBox!.width / 2;
    const sy = sourceBox!.y + sourceBox!.height / 2;

    // Mousedown + small move to activate drag
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 2, sy + 2, { steps: 2 });
    await page.waitForTimeout(100);

    // Screenshot of source square during mousedown (piece may be hidden here per KS-278 bug)
    await source.screenshot({
      path: path.join(SCREENSHOT_DIR, '05-source-square-during-mousedown.png'),
    });

    // Check if piece is visible on source during drag
    const pieceOnSource = source.locator('[data-piece]');
    const pieceCount = await pieceOnSource.count();
    let pieceOpacity = '1';
    if (pieceCount > 0) {
      pieceOpacity = await pieceOnSource.evaluate(
        (el) => window.getComputedStyle(el).opacity,
      );
    }

    console.log(`Source square during mousedown: piece count=${pieceCount}, opacity=${pieceOpacity}`);

    await page.mouse.up();
  });

  test('capture board state showing ghost element position during drag', async ({
    authenticatedPage: page,
  }) => {
    await setupPuzzleRush(page);
    const board = page.locator('.board-container');

    const source = board.locator('[data-square="d7"]');
    const target = board.locator('[data-square="d5"]');

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

    // Move to midpoint
    const midX = (sx + tx) / 2;
    const midY = (sy + ty) / 2;
    await page.mouse.move(midX, midY, { steps: 5 });
    await page.waitForTimeout(100);

    // Full board screenshot during drag
    await board.screenshot({
      path: path.join(SCREENSHOT_DIR, '06-board-during-drag-d7-to-d5.png'),
    });

    // Check ghost position relative to cursor
    const ghostInfo = await page.evaluate(({ midX, midY }) => {
      const ghosts = Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      );
      return ghosts.map((g) => {
        const rect = g.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          cursorX: midX,
          cursorY: midY,
          distanceFromCursor: Math.sqrt(
            Math.pow(rect.left + rect.width / 2 - midX, 2) +
            Math.pow(rect.top + rect.height / 2 - midY, 2),
          ),
        };
      });
    }, { midX, midY });

    console.log('Ghost info during drag:', JSON.stringify(ghostInfo, null, 2));

    await page.mouse.move(tx, ty, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Board after drop
    await board.screenshot({
      path: path.join(SCREENSHOT_DIR, '07-board-after-drop-d7-to-d5.png'),
    });
  });
});
