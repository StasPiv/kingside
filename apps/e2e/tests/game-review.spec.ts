import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * E2E tests for Game Review page (KS-307).
 * Covers: page load, board display, move list, navigation (buttons/keyboard/click),
 * profile game links, API data loading, i18n, CSS layout.
 */

const GAME_ID = '550e8400-e29b-41d4-a716-446655440000';

const mockGame = {
  id: GAME_ID,
  white: { id: 'w1', username: 'WhitePlayer' },
  black: { id: 'b1', username: 'BlackPlayer' },
  result: 'white',
  timeControl: '5+3',
  status: 'finished',
};

const mockMoves = [
  { san: 'e4', uci: 'e2e4', fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1' },
  { san: 'e5', uci: 'e7e5', fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2' },
  { san: 'Nf3', uci: 'g1f3', fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' },
  { san: 'Nc6', uci: 'b8c6', fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3' },
];

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function setupReviewMocks(page: import('@playwright/test').Page, gameId = GAME_ID) {
  return Promise.all([
    page.route(`**/api/games/${gameId}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockGame),
      }),
    ),
    page.route(`**/api/games/${gameId}/moves`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockMoves),
      }),
    ),
  ]);
}

function setLocale(page: import('@playwright/test').Page, locale: 'en' | 'ru') {
  return page.evaluate((loc) => {
    localStorage.setItem('locale', loc);
  }, locale);
}

test.describe('Game Review Page', () => {
  test('should load review page for a finished game', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    await expect(page.locator('.game-page')).toBeVisible();
    await expect(page.locator('.game-board-area')).toBeVisible();
    await expect(page.locator('.game-sidebar')).toBeVisible();
  });

  test('should display chessboard correctly', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    await expect(page.locator('.board-container')).toBeVisible();
    // Board should have aspect-ratio: 1 (square)
    const aspectRatio = await page.locator('.board-container').evaluate(
      (el) => getComputedStyle(el).aspectRatio,
    );
    expect(aspectRatio).toBe('1 / 1');
  });

  test('should display player names', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    const playerNames = page.locator('.player-name');
    await expect(playerNames).toHaveCount(2);

    await expect(page.locator('.opponent-info .player-name')).toHaveText('BlackPlayer');
    await expect(page.locator('.player-info-self .player-name')).toHaveText('WhitePlayer');
  });

  test('should display full move list', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await setLocale(page, 'en');
    await navigateTo(page, `/game/${GAME_ID}/review`);

    await expect(page.locator('.move-list')).toBeVisible();
    await expect(page.locator('.move-list h3')).toHaveText('Moves');

    const moves = page.locator('.review-move');
    await expect(moves).toHaveCount(4);

    await expect(moves.nth(0)).toHaveText('e4');
    await expect(moves.nth(1)).toHaveText('e5');
    await expect(moves.nth(2)).toHaveText('Nf3');
    await expect(moves.nth(3)).toHaveText('Nc6');
  });

  test('should display move numbers', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    const moveNumbers = page.locator('.move-number');
    await expect(moveNumbers).toHaveCount(2);
    await expect(moveNumbers.nth(0)).toHaveText('1.');
    await expect(moveNumbers.nth(1)).toHaveText('2.');
  });

  test('should highlight last move as active by default', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    const activeMove = page.locator('.review-move.active');
    await expect(activeMove).toHaveCount(1);
    await expect(activeMove).toHaveText('Nc6');
  });

  test('should navigate moves with forward/back buttons', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    const buttons = page.locator('.review-controls button');
    await expect(buttons).toHaveCount(4);

    const [toStartBtn, backBtn, forwardBtn, toEndBtn] = [
      buttons.nth(0),
      buttons.nth(1),
      buttons.nth(2),
      buttons.nth(3),
    ];

    // Initially at last move — forward and toEnd should be disabled
    await expect(forwardBtn).toBeDisabled();
    await expect(toEndBtn).toBeDisabled();

    // Go back one move
    await backBtn.click();
    const activeMove = page.locator('.review-move.active');
    await expect(activeMove).toHaveText('Nf3');

    // Go to start
    await toStartBtn.click();
    await expect(page.locator('.review-move.active')).not.toBeVisible();
    // toStart and back should be disabled at start position
    await expect(toStartBtn).toBeDisabled();
    await expect(backBtn).toBeDisabled();

    // Go to end
    await toEndBtn.click();
    await expect(page.locator('.review-move.active')).toHaveText('Nc6');
  });

  test('should navigate moves with arrow keys', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    // Start at last move (Nc6, index 3)
    await expect(page.locator('.review-move.active')).toHaveText('Nc6');

    // ArrowLeft -> Nf3
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.review-move.active')).toHaveText('Nf3');

    // ArrowLeft -> e5
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.review-move.active')).toHaveText('e5');

    // ArrowRight -> Nf3
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.review-move.active')).toHaveText('Nf3');

    // Home -> start position (no active move)
    await page.keyboard.press('Home');
    await expect(page.locator('.review-move.active')).not.toBeVisible();

    // End -> last move
    await page.keyboard.press('End');
    await expect(page.locator('.review-move.active')).toHaveText('Nc6');
  });

  test('should update board when clicking a move in the list', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    // Click on first move
    const moves = page.locator('.review-move');
    await moves.nth(0).click();
    await expect(page.locator('.review-move.active')).toHaveText('e4');

    // Click on third move
    await moves.nth(2).click();
    await expect(page.locator('.review-move.active')).toHaveText('Nf3');
  });

  test('should display game result (en)', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await setLocale(page, 'en');
    await navigateTo(page, `/game/${GAME_ID}/review`);

    const resultSection = page.locator('.game-result');
    await expect(resultSection).toBeVisible();
    await expect(resultSection.locator('h3')).toHaveText('Game over');
    await expect(resultSection.locator('p')).toHaveText('White wins');
    await expect(resultSection.locator('.game-tc')).toHaveText('5+3');
  });

  test('should display game result for draw', async ({ authenticatedPage: page }) => {
    await page.route(`**/api/games/${GAME_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...mockGame, result: 'draw' }),
      }),
    );
    await page.route(`**/api/games/${GAME_ID}/moves`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockMoves),
      }),
    );
    await setLocale(page, 'en');
    await navigateTo(page, `/game/${GAME_ID}/review`);

    await expect(page.locator('.game-result p')).toHaveText('Draw');
  });

  test('should show error on API failure', async ({ authenticatedPage: page }) => {
    await page.route(`**/api/games/${GAME_ID}`, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    );
    await page.route(`**/api/games/${GAME_ID}/moves`, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '[]' }),
    );
    await navigateTo(page, `/game/${GAME_ID}/review`);

    await expect(page.locator('.error')).toBeVisible();
  });

  test('should show loading state while fetching data', async ({ authenticatedPage: page }) => {
    await page.route(`**/api/games/${GAME_ID}`, async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockGame),
      });
    });
    await page.route(`**/api/games/${GAME_ID}/moves`, async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockMoves),
      });
    });

    await navigateTo(page, `/game/${GAME_ID}/review`);
    await expect(page.locator('.loading')).toBeVisible();
  });

  test('should have "Back to profile" link', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await setLocale(page, 'en');
    await navigateTo(page, `/game/${GAME_ID}/review`);

    const backLink = page.locator('.review-back-link');
    await expect(backLink).toBeVisible();
    await expect(backLink).toHaveText('Back to profile');
    await expect(backLink).toHaveAttribute('href', '/profile');
  });

  test('should display button titles for accessibility (en)', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await setLocale(page, 'en');
    await navigateTo(page, `/game/${GAME_ID}/review`);

    const buttons = page.locator('.review-controls button');
    await expect(buttons.nth(0)).toHaveAttribute('title', 'Go to start');
    await expect(buttons.nth(1)).toHaveAttribute('title', 'Previous move');
    await expect(buttons.nth(2)).toHaveAttribute('title', 'Next move');
    await expect(buttons.nth(3)).toHaveAttribute('title', 'Go to end');
  });
});

test.describe('Game Review Page — i18n (ru)', () => {
  test('should display Russian translations', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await setLocale(page, 'ru');
    await navigateTo(page, `/game/${GAME_ID}/review`);

    await expect(page.locator('.review-back-link')).toHaveText('Назад к профилю');

    const buttons = page.locator('.review-controls button');
    await expect(buttons.nth(0)).toHaveAttribute('title', 'В начало');
    await expect(buttons.nth(1)).toHaveAttribute('title', 'Предыдущий ход');
    await expect(buttons.nth(2)).toHaveAttribute('title', 'Следующий ход');
    await expect(buttons.nth(3)).toHaveAttribute('title', 'В конец');
  });
});

test.describe('Game Review Page — Profile integration', () => {
  test('should navigate from profile game list to review page', async ({
    authenticatedPage: page,
  }) => {
    const userId = await page.evaluate(() => {
      const token = localStorage.getItem('token');
      if (!token) return 'unknown';
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        return payload.sub || payload.id;
      } catch {
        return 'unknown';
      }
    });

    const profileGames = [
      {
        id: GAME_ID,
        white: { id: userId, username: 'Me' },
        black: { id: 'b1', username: 'Opponent' },
        result: '1-0',
        timeControl: '5+3',
        createdAt: '2026-03-07T18:00:00Z',
      },
    ];

    await page.route(`**/api/users/${userId}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: userId,
          username: 'Me',
          ratingBullet: 1200,
          ratingBlitz: 1350,
          ratingRapid: 1500,
          ratingClassical: 1600,
          createdAt: '2025-06-15T10:00:00Z',
          lastSeenAt: '2026-03-08T12:00:00Z',
        }),
      }),
    );
    await page.route(`**/api/users/${userId}/games*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(profileGames),
      }),
    );
    await page.route(`**/api/users/${userId}/puzzle-rush-stats`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ best3: 0, best5: 0, totalSessions: 0 }),
      }),
    );

    await navigateTo(page, '/profile');
    await expect(page.locator('.profile-page')).toBeVisible();

    const gameLink = page.locator('.game-record-link').first();
    await expect(gameLink).toBeVisible();
    await expect(gameLink).toHaveAttribute('href', `/game/${GAME_ID}/review`);
  });
});

test.describe('Game Review Page — CSS layout', () => {
  test('should have correct flex layout', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    const gamePage = page.locator('.game-page');
    await expect(gamePage).toBeVisible();

    const display = await gamePage.evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe('flex');

    const gap = await gamePage.evaluate((el) => getComputedStyle(el).gap);
    expect(gap).toBe('24px');
  });

  test('should have correct sidebar width', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    const sidebar = page.locator('.game-sidebar');
    const width = await sidebar.evaluate((el) => getComputedStyle(el).width);
    expect(width).toBe('280px');
  });

  test('should have correct review-move active style', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    const activeMove = page.locator('.review-move.active');
    await expect(activeMove).toBeVisible();

    const bgColor = await activeMove.evaluate((el) => getComputedStyle(el).backgroundColor);
    // #7c83ff = rgb(124, 131, 255)
    expect(bgColor).toBe('rgb(124, 131, 255)');
  });

  test('should have cursor pointer on review-move', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    const move = page.locator('.review-move').first();
    const cursor = await move.evaluate((el) => getComputedStyle(el).cursor);
    expect(cursor).toBe('pointer');
  });

  test('review-controls should be centered', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    const controls = page.locator('.review-controls');
    const justifyContent = await controls.evaluate((el) => getComputedStyle(el).justifyContent);
    expect(justifyContent).toBe('center');
  });

  test('dragging should be disabled on review board', async ({ authenticatedPage: page }) => {
    await setupReviewMocks(page);
    await navigateTo(page, `/game/${GAME_ID}/review`);

    const boardContainer = page.locator('.board-container');
    await expect(boardContainer).toBeVisible();

    const touchAction = await boardContainer.evaluate((el) => getComputedStyle(el).touchAction);
    expect(touchAction).toBe('none');
  });
});
