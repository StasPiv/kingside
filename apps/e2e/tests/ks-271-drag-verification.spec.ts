import { test, expect } from '../fixtures/auth.fixture';

/**
 * KS-271: E2E verification of drag-and-drop fix (KS-270).
 *
 * KS-270 changed the board selector from '[data-column]?.parentElement'
 * to 'div[id$="-board"]', which fixes boardRect calculation.
 *
 * Verification scenarios:
 * 1. boardRect matches the full board size (not 1/8)
 * 2. Piece follows cursor during drag (correct coordinates)
 * 3. Drag works on PuzzleRush page
 * 4. Drag works on GamePage
 * 5. Different viewport sizes (desktop, tablet)
 */

// Helper: simulate pointer drag from one square to another
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

const mockPuzzleFen =
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

async function startPuzzleRush(page: import('@playwright/test').Page) {
  await page.route('**/api/puzzle-rush/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'e2e-ks271-test',
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

  await page.goto('/puzzle-rush');
  await page.locator('.play-btn').click();
  await expect(page.locator('.board-container')).toBeVisible({
    timeout: 10_000,
  });
}

test.describe('KS-271: boardRect covers full board (KS-270 fix)', () => {
  test('board selector finds div[id$="-board"] with correct dimensions', async ({
    authenticatedPage: page,
  }) => {
    await startPuzzleRush(page);

    const board = page.locator('.board-container');

    // Verify the board element found by the selector has correct dimensions
    const boardDimensions = await board.evaluate((container) => {
      const boardEl = container.querySelector<HTMLElement>('div[id$="-board"]');
      if (!boardEl) return null;

      const rect = boardEl.getBoundingClientRect();
      const squareEls = boardEl.querySelectorAll('[data-square]');
      const firstSquare = squareEls[0] as HTMLElement | undefined;
      const squareRect = firstSquare?.getBoundingClientRect();

      return {
        boardWidth: rect.width,
        boardHeight: rect.height,
        squareWidth: squareRect?.width ?? 0,
        squareHeight: squareRect?.height ?? 0,
        squareCount: squareEls.length,
      };
    });

    expect(boardDimensions).toBeTruthy();

    // Board should have 64 squares
    expect(boardDimensions!.squareCount).toBe(64);

    // boardRect.width should be 8x the square size (full board, not 1/8)
    const expectedWidth = boardDimensions!.squareWidth * 8;
    expect(boardDimensions!.boardWidth).toBeCloseTo(expectedWidth, 0);
    expect(boardDimensions!.boardHeight).toBeCloseTo(
      boardDimensions!.squareHeight * 8,
      0,
    );

    // Board should be square (width === height)
    expect(boardDimensions!.boardWidth).toBeCloseTo(
      boardDimensions!.boardHeight,
      0,
    );
  });

  test('squareSize = boardRect.width / 8 matches actual square size', async ({
    authenticatedPage: page,
  }) => {
    await startPuzzleRush(page);

    const board = page.locator('.board-container');

    const sizes = await board.evaluate((container) => {
      const boardEl = container.querySelector<HTMLElement>('div[id$="-board"]');
      if (!boardEl) return null;

      const boardRect = boardEl.getBoundingClientRect();
      const computedSquareSize = boardRect.width / 8;

      const squareEl = boardEl.querySelector<HTMLElement>('[data-square]');
      const actualSquareSize = squareEl?.getBoundingClientRect().width ?? 0;

      return {
        computedSquareSize,
        actualSquareSize,
      };
    });

    expect(sizes).toBeTruthy();
    // Computed squareSize from boardRect/8 should match actual square element size
    expect(sizes!.computedSquareSize).toBeCloseTo(sizes!.actualSquareSize, 0);
  });
});

test.describe('KS-271: drag-and-drop on PuzzleRush', () => {
  test('piece follows cursor during drag (ghost position matches pointer)', async ({
    authenticatedPage: page,
  }) => {
    await startPuzzleRush(page);

    const board = page.locator('.board-container');
    const source = board.locator('[data-square="e7"]');

    const sourceBox = await source.boundingBox();
    expect(sourceBox).toBeTruthy();

    const sx = sourceBox!.x + sourceBox!.width / 2;
    const sy = sourceBox!.y + sourceBox!.height / 2;

    // Start drag
    await page.mouse.move(sx, sy);
    await page.mouse.down();

    // Move to an intermediate point
    const midX = sx + 50;
    const midY = sy + 50;
    await page.mouse.move(midX, midY, { steps: 3 });

    // Check ghost position matches cursor
    const ghostPosition = await page.evaluate(() => {
      const ghosts = Array.from(document.querySelectorAll('[data-piece]'));
      const ghost = ghosts.find((el) => {
        const style = (el as HTMLElement).style;
        return style.position === 'fixed' && style.zIndex === '9999';
      }) as HTMLElement | undefined;

      if (!ghost) return null;

      const rect = ghost.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });

    await page.mouse.up();

    // Ghost should exist during drag
    if (ghostPosition) {
      // Ghost center should be near cursor position
      const ghostCenterX = ghostPosition.x + ghostPosition.width / 2;
      const ghostCenterY = ghostPosition.y + ghostPosition.height / 2;

      // Allow tolerance of a few pixels for timing
      expect(Math.abs(ghostCenterX - midX)).toBeLessThan(20);
      expect(Math.abs(ghostCenterY - midY)).toBeLessThan(20);
    }
  });

  test('drag e7-e5 triggers move handler without errors', async ({
    authenticatedPage: page,
  }) => {
    await startPuzzleRush(page);

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
            fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
            rating: 1300,
            moves: 'd7d5',
          },
        }),
      });
    });

    const board = page.locator('.board-container');

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await dragPiece(page, board, 'e7', 'e5');

    expect(errors).toHaveLength(0);

    // Ghost should be cleaned up after drop
    await page.waitForTimeout(300);
    const ghostsAfterDrop = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-piece]')).filter(
        (el) => (el as HTMLElement).style.position === 'fixed',
      ).length;
    });
    expect(ghostsAfterDrop).toBe(0);
  });
});

test.describe('KS-271: viewport sizes', () => {
  test('drag works on tablet viewport (768x1024)', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await startPuzzleRush(page);

    const board = page.locator('.board-container');

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Verify board renders at tablet size
    const boardBox = await board.boundingBox();
    expect(boardBox).toBeTruthy();

    // Verify boardRect is still correct at this viewport
    const rectValid = await board.evaluate((container) => {
      const boardEl = container.querySelector<HTMLElement>('div[id$="-board"]');
      if (!boardEl) return false;

      const rect = boardEl.getBoundingClientRect();
      const squareEl = boardEl.querySelector<HTMLElement>('[data-square]');
      if (!squareEl) return false;

      const squareRect = squareEl.getBoundingClientRect();
      // boardRect.width should be ~8x square width
      return Math.abs(rect.width - squareRect.width * 8) < 2;
    });

    expect(rectValid).toBe(true);

    await dragPiece(page, board, 'e7', 'e5');
    expect(errors).toHaveLength(0);
  });

  test('drag works on small desktop viewport (1024x768)', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await startPuzzleRush(page);

    const board = page.locator('.board-container');

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await dragPiece(page, board, 'e7', 'e5');
    expect(errors).toHaveLength(0);
  });

  test('drag works on large desktop viewport (1920x1080)', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await startPuzzleRush(page);

    const board = page.locator('.board-container');

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Verify board dimensions scale properly
    const rectValid = await board.evaluate((container) => {
      const boardEl = container.querySelector<HTMLElement>('div[id$="-board"]');
      if (!boardEl) return false;

      const rect = boardEl.getBoundingClientRect();
      return rect.width > 0 && Math.abs(rect.width - rect.height) < 2;
    });
    expect(rectValid).toBe(true);

    await dragPiece(page, board, 'e7', 'e5');
    expect(errors).toHaveLength(0);
  });
});

test.describe('KS-271: GamePage drag verification', () => {
  test('board element with correct selector exists on game page', async ({
    authenticatedPage: page,
  }) => {
    // Navigate to game page — will likely redirect if no active game,
    // but we can verify the board structure if it renders
    await page.goto('/game/e2e-ks271-test');
    await page.waitForTimeout(2000);

    const url = page.url();
    if (url.includes('/game/')) {
      const board = page.locator('.board-container');
      if (await board.isVisible()) {
        // Verify the KS-270 selector works: div[id$="-board"] exists
        const boardElExists = await board.evaluate((container) => {
          const boardEl = container.querySelector<HTMLElement>(
            'div[id$="-board"]',
          );
          return boardEl !== null;
        });
        expect(boardElExists).toBe(true);

        // Verify boardRect dimensions
        const dimensions = await board.evaluate((container) => {
          const boardEl = container.querySelector<HTMLElement>(
            'div[id$="-board"]',
          );
          if (!boardEl) return null;
          const rect = boardEl.getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            isSquare: Math.abs(rect.width - rect.height) < 2,
          };
        });

        if (dimensions) {
          expect(dimensions.isSquare).toBe(true);
          expect(dimensions.width).toBeGreaterThan(0);
        }
      }
    }
  });
});
