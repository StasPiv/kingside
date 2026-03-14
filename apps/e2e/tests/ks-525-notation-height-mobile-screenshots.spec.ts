import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

/**
 * KS-525: Mobile screenshots confirming notation block bottom border
 * aligns with the bottom of the viewport (mobile viewport).
 */

const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots', 'KS-525-mobile');

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
];

const MOBILE_VIEWPORTS = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 14', width: 390, height: 844 },
  { name: 'Android', width: 360, height: 800 },
] as const;

for (const viewport of MOBILE_VIEWPORTS) {
  test.describe(`KS-525 Mobile — ${viewport.name} (${viewport.width}x${viewport.height})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test.beforeAll(() => {
      if (!fs.existsSync(SCREENSHOT_DIR)) {
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      }
    });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem('token', 'mock-token-ks525');
        localStorage.setItem('refreshToken', 'mock-refresh-ks525');
      });

      await page.route('**/api/auth/me', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockUser),
        }),
      );

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

    test('analysis page — full viewport screenshot', async ({ page }) => {
      await page.goto(`/analysis/${GAME_ID}`);
      await page.waitForTimeout(2000);

      const slug = viewport.name.toLowerCase().replace(/\s+/g, '-');
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `${slug}-full-viewport.png`),
        fullPage: false,
      });
    });
  });
}
