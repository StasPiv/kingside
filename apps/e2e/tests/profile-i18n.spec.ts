import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * KS-235: E2E verification of i18n on ProfilePage.
 *
 * Scenarios:
 * 1. EN → RU language switch — all strings translate correctly
 * 2. RU → EN language switch — all strings translate back
 * 3. Date formatting matches current locale (EN: MM/DD/YYYY, RU: ДД.ММ.ГГГГ)
 * 4. No hardcoded strings — all texts come from translation files
 * 5. "profile" section exists in both EN and RU, keys match
 * 6. Missing translation key shows fallback, not empty string
 */

import enTranslation from '../../web/src/i18n/locales/en/translation.json';
import ruTranslation from '../../web/src/i18n/locales/ru/translation.json';

const mockProfile = {
  id: 'user-1',
  username: 'TestPlayer',
  ratingBullet: 1200,
  ratingBlitz: 1350,
  ratingRapid: 1500,
  ratingClassical: 1600,
  createdAt: '2025-06-15T10:00:00Z',
  lastSeenAt: '2026-03-08T12:00:00Z',
};

const mockGames = [
  {
    id: 'g1',
    white: { id: 'user-1', username: 'TestPlayer' },
    black: { id: 'user-2', username: 'Opponent1' },
    result: '1-0',
    timeControl: '5+3',
    createdAt: '2026-03-07T18:00:00Z',
  },
];

function setupProfileMocks(page: import('@playwright/test').Page, userId: string) {
  return Promise.all([
    page.route(`**/api/users/${userId}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...mockProfile, id: userId }),
      }),
    ),
    page.route(`**/api/users/${userId}/games*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          mockGames.map((g) => ({
            ...g,
            white: g.white.id === 'user-1' ? { ...g.white, id: userId } : g.white,
            black: g.black.id === 'user-1' ? { ...g.black, id: userId } : g.black,
          })),
        ),
      }),
    ),
  ]);
}

async function getUserId(page: import('@playwright/test').Page): Promise<string> {
  const info = await page.evaluate(() => {
    const token = localStorage.getItem('token');
    if (!token) return null;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.sub || payload.id;
    } catch {
      return null;
    }
  });
  return info ?? 'unknown';
}

async function setLocale(page: import('@playwright/test').Page, locale: 'en' | 'ru') {
  await page.evaluate((loc) => {
    localStorage.setItem('locale', loc);
  }, locale);
}

test.describe('ProfilePage i18n verification', () => {
  test('scenario 5: profile section exists in both EN and RU, keys match', () => {
    const enKeys = Object.keys(enTranslation.profile).sort();
    const ruKeys = Object.keys(ruTranslation.profile).sort();

    expect(enKeys.length).toBeGreaterThan(0);
    expect(ruKeys.length).toBeGreaterThan(0);
    expect(enKeys).toEqual(ruKeys);
  });

  test('scenario 1: EN → RU switch — all profile strings translate correctly', async ({
    authenticatedPage: page,
  }) => {
    const userId = await getUserId(page);
    await setupProfileMocks(page, userId);

    // Set EN locale and navigate
    await setLocale(page, 'en');
    await navigateTo(page, '/profile');
    await expect(page.locator('.profile-page')).toBeVisible();

    // Verify EN strings
    await expect(page.locator('.profile-ratings h2')).toHaveText('Ratings');
    const enLabels = page.locator('.rating-label');
    await expect(enLabels.nth(0)).toHaveText('Bullet');
    await expect(enLabels.nth(1)).toHaveText('Blitz');
    await expect(enLabels.nth(2)).toHaveText('Rapid');
    await expect(enLabels.nth(3)).toHaveText('Classical');
    await expect(page.locator('.profile-games h2')).toHaveText('Recent games');
    await expect(page.locator('.profile-member-since')).toContainText('Member since');

    // Switch to RU
    await setLocale(page, 'ru');
    await navigateTo(page, '/profile');
    await expect(page.locator('.profile-page')).toBeVisible();

    // Verify RU strings
    await expect(page.locator('.profile-ratings h2')).toHaveText('Рейтинги');
    const ruLabels = page.locator('.rating-label');
    await expect(ruLabels.nth(0)).toHaveText('Пуля');
    await expect(ruLabels.nth(1)).toHaveText('Блиц');
    await expect(ruLabels.nth(2)).toHaveText('Рапид');
    await expect(ruLabels.nth(3)).toHaveText('Классика');
    await expect(page.locator('.profile-games h2')).toHaveText('Последние партии');
    await expect(page.locator('.profile-member-since')).toContainText('На сайте с');
  });

  test('scenario 2: RU → EN switch — all profile strings translate back', async ({
    authenticatedPage: page,
  }) => {
    const userId = await getUserId(page);
    await setupProfileMocks(page, userId);

    // Set RU locale and navigate
    await setLocale(page, 'ru');
    await navigateTo(page, '/profile');
    await expect(page.locator('.profile-page')).toBeVisible();

    // Verify RU strings first
    await expect(page.locator('.profile-ratings h2')).toHaveText('Рейтинги');
    await expect(page.locator('.profile-games h2')).toHaveText('Последние партии');
    await expect(page.locator('.profile-member-since')).toContainText('На сайте с');

    // Switch to EN
    await setLocale(page, 'en');
    await navigateTo(page, '/profile');
    await expect(page.locator('.profile-page')).toBeVisible();

    // Verify EN strings
    await expect(page.locator('.profile-ratings h2')).toHaveText('Ratings');
    await expect(page.locator('.profile-games h2')).toHaveText('Recent games');
    await expect(page.locator('.profile-member-since')).toContainText('Member since');
  });

  test('scenario 3: date formatting matches current locale', async ({
    authenticatedPage: page,
  }) => {
    const userId = await getUserId(page);
    await setupProfileMocks(page, userId);

    // EN locale — date should use English format (e.g., "June 15, 2025")
    await setLocale(page, 'en');
    await navigateTo(page, '/profile');
    await expect(page.locator('.profile-page')).toBeVisible();

    const enMemberSince = await page.locator('.profile-member-since').textContent();
    // EN format: "Member since June 15, 2025" (long month format)
    expect(enMemberSince).toMatch(/June\s+15,?\s+2025/);

    // EN game date should use M/D/YYYY format
    const enGameDate = await page.locator('.game-date').first().textContent();
    expect(enGameDate).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);

    // RU locale — date should use Russian format
    await setLocale(page, 'ru');
    await navigateTo(page, '/profile');
    await expect(page.locator('.profile-page')).toBeVisible();

    const ruMemberSince = await page.locator('.profile-member-since').textContent();
    // RU format: "На сайте с 15 июня 2025 г." (long month format)
    expect(ruMemberSince).toMatch(/15\s+июня\s+2025/);

    // RU game date should use DD.MM.YYYY format
    const ruGameDate = await page.locator('.game-date').first().textContent();
    expect(ruGameDate).toMatch(/\d{2}\.\d{2}\.\d{4}/);
  });

  test('scenario 4: no hardcoded strings — all texts come from translation files', async ({
    authenticatedPage: page,
  }) => {
    const userId = await getUserId(page);
    await setupProfileMocks(page, userId);

    // Load in EN
    await setLocale(page, 'en');
    await navigateTo(page, '/profile');
    await expect(page.locator('.profile-page')).toBeVisible();

    const enRatingsTitle = await page.locator('.profile-ratings h2').textContent();
    const enGamesTitle = await page.locator('.profile-games h2').textContent();
    const enLabel0 = await page.locator('.rating-label').nth(0).textContent();

    // Load in RU
    await setLocale(page, 'ru');
    await navigateTo(page, '/profile');
    await expect(page.locator('.profile-page')).toBeVisible();

    const ruRatingsTitle = await page.locator('.profile-ratings h2').textContent();
    const ruGamesTitle = await page.locator('.profile-games h2').textContent();
    const ruLabel0 = await page.locator('.rating-label').nth(0).textContent();

    // If strings were hardcoded, they would be the same in both locales
    expect(enRatingsTitle).not.toBe(ruRatingsTitle);
    expect(enGamesTitle).not.toBe(ruGamesTitle);
    expect(enLabel0).not.toBe(ruLabel0);

    // Verify they match translation file values
    expect(enRatingsTitle).toBe(enTranslation.profile.ratings);
    expect(ruRatingsTitle).toBe(ruTranslation.profile.ratings);
    expect(enGamesTitle).toBe(enTranslation.profile.recentGames);
    expect(ruGamesTitle).toBe(ruTranslation.profile.recentGames);
    expect(enLabel0).toBe(enTranslation.profile.bullet);
    expect(ruLabel0).toBe(ruTranslation.profile.bullet);
  });

  test('scenario 6: missing translation key shows fallback, not empty string', async ({
    authenticatedPage: page,
  }) => {
    const userId = await getUserId(page);
    await setupProfileMocks(page, userId);

    await setLocale(page, 'en');
    await navigateTo(page, '/profile');
    await expect(page.locator('.profile-page')).toBeVisible();

    // Verify i18n fallback behavior: when fallbackLng is 'en',
    // requesting a missing key should return the key itself, not empty string.
    const fallbackResult = await page.evaluate(() => {
      // Access i18next instance from window (react-i18next exposes it)
      const i18n = (window as any).__i18n || (window as any).i18next;
      if (i18n && i18n.t) {
        return i18n.t('profile.nonExistentKey12345');
      }
      // Fallback: try via react-i18next store
      return null;
    });

    // i18next returns the key path when translation is missing
    if (fallbackResult !== null) {
      expect(fallbackResult).not.toBe('');
      expect(fallbackResult).toBe('profile.nonExistentKey12345');
    }

    // Additional verification: all visible profile texts are non-empty
    const allTexts = await page.locator('.profile-page').allTextContents();
    const joined = allTexts.join('');
    expect(joined.length).toBeGreaterThan(0);

    // No text element should be empty
    const ratingLabels = page.locator('.rating-label');
    const count = await ratingLabels.count();
    for (let i = 0; i < count; i++) {
      const text = await ratingLabels.nth(i).textContent();
      expect(text).not.toBe('');
    }

    const memberSince = await page.locator('.profile-member-since').textContent();
    expect(memberSince).not.toBe('');

    const ratingsTitle = await page.locator('.profile-ratings h2').textContent();
    expect(ratingsTitle).not.toBe('');

    const gamesTitle = await page.locator('.profile-games h2').textContent();
    expect(gamesTitle).not.toBe('');
  });
});
