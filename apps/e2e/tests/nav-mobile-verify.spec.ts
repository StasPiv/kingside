import { test, expect, navigateTo } from '../fixtures/auth.fixture';
import { test as base } from '@playwright/test';
import path from 'path';

const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots', 'KS-261');

/**
 * KS-261: E2E verification of KS-257 fix — nav overlap on mobile (375px).
 *
 * Scenarios:
 * 1. Navigation at 375px: links don't overlap, wrap correctly
 * 2. Navigation at 480px: flex-wrap works, no overflow
 * 3. Navigation at 768px: flex-wrap works correctly
 * 4. Navigation at 1024px+: no regression, layout intact
 * 5. Font-size and gap are adequate on mobile viewports
 */

// ─── Helper: check no horizontal overflow ────────────────────────────────────

async function assertNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });
  expect(overflow).toBe(false);
}

async function assertNavLinksNoOverlap(page: import('@playwright/test').Page) {
  const boxes = await page.evaluate(() => {
    const nav = document.querySelector('.header nav');
    if (!nav) return [];
    const links = nav.querySelectorAll('a');
    return Array.from(links).map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, text: el.textContent };
    });
  });

  // Check that no two links on the same row overlap horizontally
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      // Same row: vertical overlap
      const sameRow = a.top < b.bottom && b.top < a.bottom;
      if (sameRow) {
        const horizOverlap = a.left < b.right && b.left < a.right;
        expect(horizOverlap, `Links "${a.text}" and "${b.text}" overlap horizontally`).toBe(false);
      }
    }
  }
}

async function getNavComputedStyles(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const nav = document.querySelector('.header nav');
    if (!nav) return null;
    const cs = getComputedStyle(nav);
    return {
      flexWrap: cs.flexWrap,
      gap: cs.gap,
      fontSize: cs.fontSize,
      padding: cs.padding,
    };
  });
}

// ─── Scenario 1: 375px viewport ─────────────────────────────────────────────

test.describe('Scenario 1: Navigation at 375px (iPhone SE)', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('nav links do not overlap and wrap correctly', async ({
    authenticatedPage: page,
  }) => {
    await assertNoHorizontalOverflow(page);
    await assertNavLinksNoOverlap(page);

    // Verify flex-wrap is applied
    const styles = await getNavComputedStyles(page);
    expect(styles).not.toBeNull();
    expect(styles!.flexWrap).toBe('wrap');

    // Verify font-size is reduced for mobile
    const fontSize = parseFloat(styles!.fontSize);
    expect(fontSize).toBeLessThanOrEqual(14);

    // All nav links are visible
    const nav = page.locator('.header nav');
    await expect(nav).toBeVisible();
    await expect(nav.locator('a').first()).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, '01-nav-375px.png'),
      fullPage: true,
    });
  });

  test('nav-links block does not overflow screen', async ({
    authenticatedPage: page,
  }) => {
    const navLinksBox = await page.evaluate(() => {
      const el = document.querySelector('.nav-links');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { right: r.right, width: r.width };
    });
    expect(navLinksBox).not.toBeNull();
    expect(navLinksBox!.right).toBeLessThanOrEqual(375);
  });
});

// ─── Scenario 2: 480px viewport ─────────────────────────────────────────────

test.describe('Scenario 2: Navigation at 480px', () => {
  test.use({ viewport: { width: 480, height: 800 } });

  test('flex-wrap works, no horizontal overflow', async ({
    authenticatedPage: page,
  }) => {
    await assertNoHorizontalOverflow(page);
    await assertNavLinksNoOverlap(page);

    const styles = await getNavComputedStyles(page);
    expect(styles).not.toBeNull();
    expect(styles!.flexWrap).toBe('wrap');

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, '02-nav-480px.png'),
      fullPage: true,
    });
  });
});

// ─── Scenario 3: 768px viewport ─────────────────────────────────────────────

test.describe('Scenario 3: Navigation at 768px (tablet)', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test('flex-wrap works correctly', async ({
    authenticatedPage: page,
  }) => {
    await assertNoHorizontalOverflow(page);
    await assertNavLinksNoOverlap(page);

    const styles = await getNavComputedStyles(page);
    expect(styles).not.toBeNull();
    expect(styles!.flexWrap).toBe('wrap');

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, '03-nav-768px.png'),
      fullPage: true,
    });
  });
});

// ─── Scenario 4: 1024px+ desktop — no regression ────────────────────────────

test.describe('Scenario 4: Navigation at 1024px+ (desktop)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('layout not broken, no regression', async ({
    authenticatedPage: page,
  }) => {
    await assertNoHorizontalOverflow(page);
    await assertNavLinksNoOverlap(page);

    // Nav should still have flex-wrap (base style)
    const styles = await getNavComputedStyles(page);
    expect(styles).not.toBeNull();
    expect(styles!.flexWrap).toBe('wrap');

    // All expected nav links present
    const nav = page.locator('.header nav');
    await expect(nav.locator('a.logo')).toBeVisible();
    await expect(nav.getByRole('link', { name: /puzzles/i }).first()).toBeVisible();
    await expect(nav.getByRole('link', { name: /puzzle rush/i }).first()).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, '04-nav-1024-desktop.png'),
      fullPage: true,
    });
  });
});

// ─── Scenario 5: Font-size and gap on mobile ────────────────────────────────

test.describe('Scenario 5: Font-size and gap on mobile viewports', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('font-size and gap are adequate at 375px', async ({
    authenticatedPage: page,
  }) => {
    const styles = await getNavComputedStyles(page);
    expect(styles).not.toBeNull();

    // Font-size should be 13px per mobile media query
    const fontSize = parseFloat(styles!.fontSize);
    expect(fontSize).toBe(13);

    // Verify link font-size
    const linkFontSize = await page.evaluate(() => {
      const link = document.querySelector('.header nav a:not(.logo)');
      if (!link) return null;
      return parseFloat(getComputedStyle(link).fontSize);
    });
    expect(linkFontSize).toBe(13);

    // Logo should be 16px on mobile
    const logoFontSize = await page.evaluate(() => {
      const logo = document.querySelector('.logo');
      if (!logo) return null;
      return parseFloat(getComputedStyle(logo).fontSize);
    });
    expect(logoFontSize).toBe(16);

    // Gap should be reasonable (not 0)
    const gap = styles!.gap;
    expect(gap).toBeTruthy();
    expect(gap).not.toBe('0px');

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, '05-nav-375px-fonts.png'),
      fullPage: true,
    });
  });
});

// ─── Scenario 6: Unauthenticated nav at 375px ──────────────────────────────

base.describe('Scenario 6: Unauthenticated navigation at 375px', () => {
  base.use({ viewport: { width: 375, height: 667 } });

  base('nav links do not overlap without auth', async ({ page }) => {
    await page.goto('/lobby');
    await page.waitForLoadState('networkidle');

    await assertNoHorizontalOverflow(page);
    await assertNavLinksNoOverlap(page);

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, '06-nav-375px-unauth.png'),
      fullPage: true,
    });
  });
});
