import { test, expect, navigateTo } from '../fixtures/auth.fixture';

/**
 * KS-234: E2E верификация Puzzle Rush Leaderboard
 *
 * Сценарии:
 * 1. Переход по роуту /puzzle-rush/leaderboard — страница загружается
 * 2. Переключение режимов 3/5 мин — таблица обновляется
 * 3. Подсветка текущего пользователя в таблице лидеров
 * 4. Ссылка назад на Puzzle Rush работает корректно
 * 5. Навигация из MainLayout (пункт меню rushLeaderboard) ведёт на страницу
 * 6. Переводы отображаются корректно (en, ru)
 * 7. Роут защищён ProtectedRoute — неавторизованный пользователь не имеет доступа
 */

const mockEntries = [
  { userId: 'u1', username: 'Magnus', score: 42, createdAt: '2026-01-01' },
  { userId: 'u2', username: 'Hikaru', score: 38, createdAt: '2026-01-02' },
  { userId: 'u3', username: 'Fabiano', score: 35, createdAt: '2026-01-03' },
];

function mockLeaderboardApi(page: import('@playwright/test').Page, entries = mockEntries) {
  return page.route('**/api/puzzle-rush/leaderboard*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries }),
    }),
  );
}

test.describe('KS-234: E2E верификация Puzzle Rush Leaderboard', () => {
  // --- Сценарий 1: Переход по роуту — страница загружается ---

  test('1.1 страница загружается по роуту /puzzle-rush/leaderboard', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
    await expect(page.locator('.rush-leaderboard-page h1')).toBeVisible();
  });

  test('1.2 страница содержит все основные элементы', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    // Заголовок
    await expect(page.locator('.rush-leaderboard-page h1')).toBeVisible();
    // Вкладки режимов
    await expect(page.locator('.rush-lb-mode-tabs')).toBeVisible();
    await expect(page.locator('.rush-lb-mode-tabs .tc-btn')).toHaveCount(2);
    // Таблица
    await expect(page.locator('.rush-lb-table')).toBeVisible();
    await expect(page.locator('.rush-lb-header-row')).toBeVisible();
    await expect(page.locator('.rush-lb-row')).toHaveCount(3);
    // Ссылка назад
    await expect(page.locator('.rush-lb-back-link')).toBeVisible();
  });

  // --- Сценарий 2: Переключение режимов 3/5 мин ---

  test('2.1 режим 3 мин активен по умолчанию', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    const tabs = page.locator('.rush-lb-mode-tabs .tc-btn');
    await expect(tabs.first()).toHaveClass(/active/);
    await expect(tabs.nth(1)).not.toHaveClass(/active/);
  });

  test('2.2 переключение на 5 мин обновляет таблицу', async ({ authenticatedPage: page }) => {
    const requestedModes: string[] = [];

    await page.route('**/api/puzzle-rush/leaderboard*', (route) => {
      const url = new URL(route.request().url());
      const mode = url.searchParams.get('timeMode') || '3';
      requestedModes.push(mode);

      const entries = mode === '5'
        ? [{ userId: 'u1', username: 'FiveMinChamp', score: 50, createdAt: '2026-01-01' }]
        : [{ userId: 'u2', username: 'ThreeMinChamp', score: 45, createdAt: '2026-01-01' }];

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries }),
      });
    });

    await navigateTo(page, '/puzzle-rush/leaderboard');
    await expect(page.locator('.rush-lb-row .rush-lb-col-name').first()).toHaveText('ThreeMinChamp');

    // Переключаем на 5 мин
    await page.locator('.rush-lb-mode-tabs .tc-btn').nth(1).click();
    await expect(page.locator('.rush-lb-mode-tabs .tc-btn').nth(1)).toHaveClass(/active/);
    await expect(page.locator('.rush-lb-mode-tabs .tc-btn').first()).not.toHaveClass(/active/);
    await expect(page.locator('.rush-lb-row .rush-lb-col-name').first()).toHaveText('FiveMinChamp');

    // API вызван с timeMode=5
    expect(requestedModes).toContain('5');
  });

  test('2.3 переключение обратно на 3 мин работает', async ({ authenticatedPage: page }) => {
    await page.route('**/api/puzzle-rush/leaderboard*', (route) => {
      const url = new URL(route.request().url());
      const mode = url.searchParams.get('timeMode') || '3';

      const entries = mode === '5'
        ? [{ userId: 'u1', username: 'FiveMinPlayer', score: 30, createdAt: '2026-01-01' }]
        : [{ userId: 'u2', username: 'ThreeMinPlayer', score: 25, createdAt: '2026-01-01' }];

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries }),
      });
    });

    await navigateTo(page, '/puzzle-rush/leaderboard');
    await expect(page.locator('.rush-lb-row .rush-lb-col-name').first()).toHaveText('ThreeMinPlayer');

    // 3 → 5 → 3
    await page.locator('.rush-lb-mode-tabs .tc-btn').nth(1).click();
    await expect(page.locator('.rush-lb-row .rush-lb-col-name').first()).toHaveText('FiveMinPlayer');

    await page.locator('.rush-lb-mode-tabs .tc-btn').first().click();
    await expect(page.locator('.rush-lb-mode-tabs .tc-btn').first()).toHaveClass(/active/);
    await expect(page.locator('.rush-lb-row .rush-lb-col-name').first()).toHaveText('ThreeMinPlayer');
  });

  // --- Сценарий 3: Подсветка текущего пользователя ---

  test('3.1 строка текущего пользователя имеет класс rush-lb-row-current', async ({ authenticatedPage: page }) => {
    // Получаем ID текущего пользователя из токена
    const userInfo = await page.evaluate(() => {
      const token = localStorage.getItem('token');
      if (!token) return null;
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        return { id: payload.sub || payload.id, username: payload.username };
      } catch {
        return null;
      }
    });

    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [
            { userId: 'other-1', username: 'Opponent1', score: 50, createdAt: '2026-01-01' },
            { userId: userInfo?.id ?? 'current', username: userInfo?.username ?? 'me', score: 40, createdAt: '2026-01-02' },
            { userId: 'other-2', username: 'Opponent2', score: 30, createdAt: '2026-01-03' },
          ],
        }),
      }),
    );

    await navigateTo(page, '/puzzle-rush/leaderboard');

    const rows = page.locator('.rush-lb-row');
    await expect(rows).toHaveCount(3);

    // Только строка текущего пользователя подсвечена
    await expect(rows.nth(0)).not.toHaveClass(/rush-lb-row-current/);
    await expect(rows.nth(1)).toHaveClass(/rush-lb-row-current/);
    await expect(rows.nth(2)).not.toHaveClass(/rush-lb-row-current/);
  });

  test('3.2 при отсутствии текущего пользователя ни одна строка не подсвечена', async ({ authenticatedPage: page }) => {
    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [
            { userId: 'other-1', username: 'Player1', score: 50, createdAt: '2026-01-01' },
            { userId: 'other-2', username: 'Player2', score: 40, createdAt: '2026-01-02' },
          ],
        }),
      }),
    );

    await navigateTo(page, '/puzzle-rush/leaderboard');

    const highlightedRows = page.locator('.rush-lb-row-current');
    await expect(highlightedRows).toHaveCount(0);
  });

  // --- Сценарий 4: Ссылка назад на Puzzle Rush ---

  test('4.1 ссылка "назад" ведёт на /puzzle-rush', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    const backLink = page.locator('.rush-lb-back-link');
    await expect(backLink).toBeVisible();
    await expect(backLink).toHaveAttribute('href', '/puzzle-rush');

    await backLink.click();
    await expect(page).toHaveURL(/\/puzzle-rush$/);
    await expect(page.locator('.puzzle-rush-page')).toBeVisible();
  });

  // --- Сценарий 5: Навигация из MainLayout ---

  test('5.1 в навигации есть пункт меню rushLeaderboard', async ({ authenticatedPage: page }) => {
    await navigateTo(page, '/lobby');

    const nav = page.locator('header nav');
    const link = nav.locator('a[href="/puzzle-rush/leaderboard"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveText(/leaderboard|таблица лидеров/i);
  });

  test('5.2 клик по пункту меню ведёт на страницу leaderboard', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/lobby');

    const nav = page.locator('header nav');
    await nav.locator('a[href="/puzzle-rush/leaderboard"]').click();

    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });

  // --- Сценарий 6: Переводы (en, ru) ---

  test('6.1 английские переводы отображаются по умолчанию', async ({ authenticatedPage: page }) => {
    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page.locator('.rush-leaderboard-page h1')).toHaveText('Puzzle Rush Leaderboard');
    await expect(page.locator('.rush-lb-back-link')).toHaveText('Back to Puzzle Rush');

    const tabs = page.locator('.rush-lb-mode-tabs .tc-btn');
    await expect(tabs.first()).toHaveText('3 Minutes');
    await expect(tabs.nth(1)).toHaveText('5 Minutes');

    // Заголовки таблицы
    const header = page.locator('.rush-lb-header-row');
    await expect(header.locator('.rush-lb-col-name')).toHaveText('Player');
    await expect(header.locator('.rush-lb-col-score')).toHaveText('Score');
  });

  test('6.2 русские переводы отображаются при смене языка', async ({ authenticatedPage: page }) => {
    await page.evaluate(() => {
      localStorage.setItem('i18nextLng', 'ru');
    });

    await mockLeaderboardApi(page);
    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page.locator('.rush-leaderboard-page h1')).toHaveText('Таблица лидеров Puzzle Rush');
    await expect(page.locator('.rush-lb-back-link')).toHaveText('Назад к Puzzle Rush');

    const tabs = page.locator('.rush-lb-mode-tabs .tc-btn');
    await expect(tabs.first()).toHaveText('3 минуты');
    await expect(tabs.nth(1)).toHaveText('5 минут');

    // Заголовки таблицы
    const header = page.locator('.rush-lb-header-row');
    await expect(header.locator('.rush-lb-col-name')).toHaveText('Игрок');
    await expect(header.locator('.rush-lb-col-score')).toHaveText('Рекорд');
  });

  test('6.3 пустое состояние отображает перевод', async ({ authenticatedPage: page }) => {
    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries: [] }),
      }),
    );

    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page.locator('.rush-lb-empty')).toHaveText('No results yet');
  });

  test('6.4 пустое состояние на русском', async ({ authenticatedPage: page }) => {
    await page.evaluate(() => {
      localStorage.setItem('i18nextLng', 'ru');
    });

    await page.route('**/api/puzzle-rush/leaderboard*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries: [] }),
      }),
    );

    await navigateTo(page, '/puzzle-rush/leaderboard');

    await expect(page.locator('.rush-lb-empty')).toHaveText('Результатов пока нет');
  });

  // --- Сценарий 7: Публичный роут (KS-238 fix) ---

  test('7.1 неавторизованный пользователь видит leaderboard без редиректа', async ({ page }) => {
    await mockLeaderboardApi(page);
    await page.goto('/puzzle-rush/leaderboard');
    await expect(page).toHaveURL(/\/puzzle-rush\/leaderboard/);
    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });

  test('7.2 страница leaderboard доступна без токена', async ({ page }) => {
    await mockLeaderboardApi(page);
    await page.goto('/puzzle-rush/leaderboard');

    await expect(page.locator('.rush-leaderboard-page')).toBeVisible();
  });
});
