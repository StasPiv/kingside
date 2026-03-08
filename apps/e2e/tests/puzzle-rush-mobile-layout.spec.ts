import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * KS-262: Mobile layout verification for Puzzle Rush (KS-254).
 *
 * Verifies that mobile layout fixes work correctly across
 * multiple viewport sizes: iPhone SE, iPhone 14, Android.
 */

const VIEWPORTS = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 14', width: 390, height: 844 },
  { name: 'Android', width: 360, height: 800 },
] as const;

for (const viewport of VIEWPORTS) {
  test.describe(`Puzzle Rush mobile layout — ${viewport.name} (${viewport.width}x${viewport.height})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('navigation elements do not overlap and wrap correctly', async ({ authenticatedPage: page }) => {
      await navigateTo(page, '/puzzle-rush');

      const nav = page.locator('.header nav');
      await expect(nav).toBeVisible();

      // Nav should not overflow horizontally
      const navBox = await nav.boundingBox();
      expect(navBox).toBeTruthy();
      expect(navBox!.width).toBeLessThanOrEqual(viewport.width);

      // All nav links should be visible (flex-wrap allows wrapping)
      const links = nav.locator('a');
      const count = await links.count();
      for (let i = 0; i < count; i++) {
        await expect(links.nth(i)).toBeVisible();
      }

      // Check no link overlaps another by comparing bounding boxes
      const boxes = [];
      for (let i = 0; i < count; i++) {
        const box = await links.nth(i).boundingBox();
        if (box) boxes.push(box);
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          // Two boxes overlap if they intersect on both axes
          const overlapX = a.x < b.x + b.width && a.x + a.width > b.x;
          const overlapY = a.y < b.y + b.height && a.y + a.height > b.y;
          expect(overlapX && overlapY).toBe(false);
        }
      }
    });

    test('no horizontal overflow on Puzzle Rush page', async ({ authenticatedPage: page }) => {
      await navigateTo(page, '/puzzle-rush');
      await expect(page.locator('.puzzle-rush-page')).toBeVisible();

      // Check document scrollWidth does not exceed viewport width
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(viewport.width);
    });

    test('chess board fits within viewport during play', async ({ authenticatedPage: page }) => {
      await navigateTo(page, '/puzzle-rush');
      await page.locator('.play-btn').click();

      await expect(page.locator('.board-container')).toBeVisible({ timeout: 10_000 });

      const boardBox = await page.locator('.board-container').boundingBox();
      expect(boardBox).toBeTruthy();

      // Board should not exceed viewport width
      expect(boardBox!.x + boardBox!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(boardBox!.x).toBeGreaterThanOrEqual(0);

      // Board should be square (aspect-ratio: 1)
      expect(Math.abs(boardBox!.width - boardBox!.height)).toBeLessThanOrEqual(1);

      // No horizontal overflow after board renders
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(viewport.width);
    });

    test('puzzle board placeholder is constrained by screen width', async ({ authenticatedPage: page }) => {
      // Use mocked route to avoid starting a real session — just check start screen
      await navigateTo(page, '/puzzle-rush');
      await expect(page.locator('.puzzle-rush-page')).toBeVisible();

      // Start screen elements should fit within viewport
      const pageBox = await page.locator('.puzzle-rush-page').boundingBox();
      expect(pageBox).toBeTruthy();
      expect(pageBox!.width).toBeLessThanOrEqual(viewport.width);

      // Time control buttons should wrap and stay within viewport
      const timeSelect = page.locator('.puzzle-rush-time-select');
      if (await timeSelect.isVisible()) {
        const tsBox = await timeSelect.boundingBox();
        expect(tsBox).toBeTruthy();
        expect(tsBox!.x + tsBox!.width).toBeLessThanOrEqual(viewport.width + 1);
      }
    });
  });
}
