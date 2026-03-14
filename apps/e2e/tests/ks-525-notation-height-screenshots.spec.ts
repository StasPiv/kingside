import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

/**
 * KS-525: Screenshots confirming notation block bottom border
 * aligns with the bottom of the viewport.
 *
 * Captures:
 * 1. Analysis page — full viewport showing sidebar bottom edge
 * 2. Analysis page — notation panel scrollable area
 */

const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots', 'KS-525');

const GAME_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const mockUser = {
  id: 'u1',
  username: 'TestPlayer',
  email: 'test@example.com',
  ratingBullet: 1500,
  ratingBlitz: 1500,
  ratingRapid: 1500,
  ratingClassical: 1500,
  ratingPuzzle: 1500,
  locale: 'en',
};

const mockGame = {
  id: GAME_ID,
  white: { id: 'w1', username: 'WhitePlayer' },
  black: { id: 'b1', username: 'BlackPlayer' },
  result: 'white_wins',
  timeControl: '5+3',
  status: 'finished',
};

const mockMoves = [
  { san: 'e4', uci: 'e2e4', fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1' },
  { san: 'e5', uci: 'e7e5', fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2' },
  { san: 'Nf3', uci: 'g1f3', fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' },
  { san: 'Nc6', uci: 'b8c6', fenAfter: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3' },
  { san: 'd4', uci: 'd2d4', fenAfter: 'r1bqkbnr/pppp1ppp/2n5/4p3/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq d3 0 3' },
  { san: 'exd4', uci: 'e5d4', fenAfter: 'r1bqkbnr/pppp1ppp/2n5/8/3pP3/5N2/PPP2PPP/RNBQKB1R w KQkq - 0 4' },
  { san: 'Nxd4', uci: 'f3d4', fenAfter: 'r1bqkbnr/pppp1ppp/2n5/8/3NP3/8/PPP2PPP/RNBQKB1R b KQkq - 0 4' },
  { san: 'Nf6', uci: 'g8f6', fenAfter: 'r1bqkb1r/pppp1ppp/2n2n2/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq - 1 5' },
];

test.use({ viewport: { width: 1280, height: 800 } });

test.describe('KS-525: Notation block height screenshots', () => {
  test.beforeAll(() => {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
  });

  test.beforeEach(async ({ page }) => {
    // Inject auth token
    await page.addInitScript(() => {
      localStorage.setItem('token', 'mock-token-ks525');
      localStorage.setItem('refreshToken', 'mock-refresh-ks525');
    });

    // Mock auth/me
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockUser),
      }),
    );

    // Mock game data
    await page.route(`**/api/games/${GAME_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockGame),
      }),
    );

    await page.route(`**/api/games/${GAME_ID}/moves`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockMoves),
      }),
    );
  });

  test('analysis page — sidebar fills full viewport height', async ({ page }) => {
    await page.goto(`/analysis/${GAME_ID}`);
    await expect(page.locator('.analysis-sidebar')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.analysis-page')).toBeVisible();

    // Sidebar bottom should be within 16px of viewport bottom
    const sidebarBottom = await page.locator('.analysis-sidebar').evaluate((el) => {
      return Math.round(el.getBoundingClientRect().bottom);
    });
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    expect(Math.abs(sidebarBottom - viewportHeight)).toBeLessThanOrEqual(16);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '01-analysis-sidebar-full-height.png'),
      fullPage: false,
    });
  });

  test('analysis page — notation panel scrollable area visible', async ({ page }) => {
    await page.goto(`/analysis/${GAME_ID}`);
    await expect(page.locator('.analysis-sidebar')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.analysis-panel-body--scroll')).toBeVisible();

    // Panel body scroll overflow should be auto (scrollable)
    const overflow = await page.locator('.analysis-panel-body--scroll').evaluate((el) => {
      return window.getComputedStyle(el).overflowY;
    });
    expect(overflow).toBe('auto');

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '02-notation-panel-scroll.png'),
      fullPage: false,
    });
  });
});
