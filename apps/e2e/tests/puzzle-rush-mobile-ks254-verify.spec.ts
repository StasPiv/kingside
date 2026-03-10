import { test, expect, navigateTo } from '../fixtures/auth.fixture';
import { test as base } from '@playwright/test';

/**
 * KS-264: E2E верификация мобильной вёрстки Puzzle Rush (KS-254)
 *
 * Проверяемые сценарии:
 * 1. На экране 375px нет горизонтального скролла
 * 2. Текст не накладывается на другие элементы на мобильном экране
 * 3. Корректное отображение на экранах 320px, 375px, 414px
 * 4. Десктопная вёрстка не сломана после изменений
 *
 * Коммиты: d8b3986, 6b547ea
 */

const MOBILE_VIEWPORTS = [
  { name: '320px', width: 320, height: 568 },
  { name: '375px', width: 375, height: 667 },
  { name: '414px', width: 414, height: 736 },
];

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

test.describe('KS-264: Верификация мобильной вёрстки Puzzle Rush (KS-254)', () => {
  // Сценарий 1: нет горизонтального скролла на 375px
  test('375px — нет горизонтального скролла', async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await navigateTo(page, '/puzzle-rush');
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();

    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasHorizontalScroll).toBe(false);
  });

  // Сценарий 2: текст не выходит за границы контейнера
  test('375px — текст не выходит за границы viewport', async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await navigateTo(page, '/puzzle-rush');
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();

    // Проверяем, что все текстовые элементы на странице не выходят за viewport
    const overflowingElements = await page.evaluate(() => {
      const viewportWidth = document.documentElement.clientWidth;
      const elements = document.querySelectorAll('.puzzle-rush-page *');
      const overflowing: string[] = [];
      elements.forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.right > viewportWidth + 1) {
          overflowing.push(`${el.tagName}.${el.className} (right: ${rect.right}px)`);
        }
      });
      return overflowing;
    });
    expect(overflowingElements).toEqual([]);
  });

  // Сценарий 3: корректное отображение на разных мобильных экранах
  for (const vp of MOBILE_VIEWPORTS) {
    test(`${vp.name} — страница рендерится без горизонтального скролла`, async ({ authenticatedPage: page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await navigateTo(page, '/puzzle-rush');
      await expect(page.locator('.puzzle-rush-page')).toBeVisible();

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(vp.width);
    });

    test(`${vp.name} — навигация не выходит за пределы экрана`, async ({ authenticatedPage: page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await navigateTo(page, '/puzzle-rush');

      const navOverflow = await page.evaluate(() => {
        const nav = document.querySelector('.header nav');
        if (!nav) return false;
        const rect = nav.getBoundingClientRect();
        return rect.right > document.documentElement.clientWidth + 1;
      });
      expect(navOverflow).toBe(false);
    });
  }

  // Сценарий 4: десктопная вёрстка не сломана
  test('десктоп 1280px — страница корректно отображается', async ({ authenticatedPage: page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await navigateTo(page, '/puzzle-rush');
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();

    // Кнопка старта видна
    await expect(page.locator('.play-btn')).toBeVisible();

    // Ссылка на лидерборд видна
    await expect(page.locator('.rush-leaderboard-link')).toBeVisible();

    // Нет горизонтального скролла
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasHorizontalScroll).toBe(false);
  });

  test('десктоп — элементы выбора времени видны', async ({ authenticatedPage: page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await navigateTo(page, '/puzzle-rush');

    await expect(page.locator('.puzzle-rush-time-select')).toBeVisible();
    await expect(page.locator('.tc-btn').first()).toBeVisible();
  });
});

// Мобильная проверка без авторизации — leaderboard
base.describe('KS-264: Мобильная вёрстка leaderboard (публичный)', () => {
  for (const vp of MOBILE_VIEWPORTS) {
    base(`${vp.name} — leaderboard без горизонтального скролла`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            entries: [
              { userId: 'u1', username: 'TestPlayer1', score: 50, createdAt: '2026-03-01' },
              { userId: 'u2', username: 'LongUsernamePlayer', score: 45, createdAt: '2026-03-02' },
            ],
          }),
        }),
      );

      await page.goto('/puzzle-rush/leaderboard');
      await expect(page.locator('.rush-leaderboard-page')).toBeVisible();

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(vp.width);
    });
  }
});
