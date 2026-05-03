import { expect, test, type Page } from '@playwright/test';

/**
 * KS-2294 (ADR-038 §7, VC E3) — e2e палитры variation-color.
 *
 * 4 acceptance-сценария:
 *   1. open palette на main move → секция Variation color НЕ видна;
 *   2. open palette на variant move → видна, 4 кнопки + Clear;
 *   3. пометка варианта green → autosave PGN содержит `[%cvc G]`;
 *   4. clear → нет `[%cvc]` в PGN.
 *
 * Используем demo `/dev/nag-palette` → `[data-testid="variation-color-demo"]`
 * (KS-2294 demo, добавлен в DevNagPalettePage). Demo использует реальный
 * `useReviewState` + `useAdHocAnalysisAutosave` — autosave пишет PGN
 * в localStorage с throttle 1500ms.
 *
 * PGN demo: `1. e4 e5 (1... c5 2. Nf3) 2. Nf3 *`. globalIndex'ы
 * (после parse): e4=0, e5=1, c5=2 (head вариации), Nf3-в-вариации=3,
 * Nf3-main=4. e2e находит ходы по `data-testid="review-move-{N}"`.
 *
 * Локатор `popupPalette` сужает по `.review-context-menu` — на странице
 * 6 standalone-палитр в demo, popup-инстанс выделяется через обёртку
 * (как в KS-2272 / analysis-nag-palette.spec.ts).
 */

const SCREENSHOTS_DIR = '/tmp/KS-2294';

async function clearAutosaveStorage(page: Page): Promise<void> {
  // KS-2281: autosave-ключ `analysis:adhoc:<base64(initialFen)>`.
  // initialFen demo = стандартный INITIAL_FEN. Чистим ВСЕ adhoc-ключи
  // через page.evaluate, чтобы тесты не зависели от прошлых прогонов.
  await page.evaluate(() => {
    const keys = Object.keys(localStorage);
    for (const k of keys) {
      if (k.startsWith('analysis:adhoc:')) localStorage.removeItem(k);
    }
  });
}

async function gotoDemo(page: Page): Promise<void> {
  await page.goto('/dev/nag-palette');
  await expect(page.getByTestId('variation-color-demo')).toBeVisible({
    timeout: 15_000,
  });
}

function popupPalette(page: Page) {
  // На странице 6 standalone-палитр + popup из ReviewMoveList.
  // popup отличается обёрткой `.review-context-menu`.
  return page.locator('.review-context-menu').getByTestId('nag-palette');
}

function variationColorSection(page: Page) {
  return page
    .locator('.review-context-menu')
    .getByTestId('nag-palette-variation-color');
}

async function rightClickMoveInDemo(page: Page, globalIndex: number) {
  const demo = page.getByTestId('variation-color-demo');
  await demo
    .getByTestId(`review-move-${globalIndex}`)
    .click({ button: 'right' });
}

async function readAutosavePgn(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((k) =>
      k.startsWith('analysis:adhoc:'),
    );
    if (keys.length === 0) return null;
    return localStorage.getItem(keys[0]);
  });
}

test.describe('KS-2294 — variation-color e2e (desktop)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/nag-palette');
    await clearAutosaveStorage(page);
  });

  test('main move → секция Variation color НЕ видна', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'right-click — desktop trigger.',
    );
    await gotoDemo(page);
    // e4 — main-line move (globalIndex=0 после parse PGN '1. e4 ...').
    await rightClickMoveInDemo(page, 0);
    await expect(popupPalette(page)).toBeVisible();
    await expect(variationColorSection(page)).toHaveCount(0);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/01-main-no-variation-color.png`,
      fullPage: true,
    });
  });

  test('variant move → секция видна, 4 swatch + Clear', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop');
    await gotoDemo(page);
    // c5 — head вариации (globalIndex=2 в demo PGN).
    await rightClickMoveInDemo(page, 2);
    await expect(popupPalette(page)).toBeVisible();
    const section = variationColorSection(page);
    await expect(section).toBeVisible();
    for (const color of ['green', 'blue', 'yellow', 'red'] as const) {
      await expect(
        page
          .locator('.review-context-menu')
          .getByTestId(`nag-palette-variation-color-${color}`),
      ).toBeVisible();
    }
    await expect(
      page
        .locator('.review-context-menu')
        .getByTestId('nag-palette-variation-color-clear'),
    ).toBeVisible();
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/02-variant-shows-section.png`,
      fullPage: true,
    });
  });

  test('пометка варианта green → autosave PGN содержит [%cvc G]', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop');
    await gotoDemo(page);
    // c5 — head вариации (globalIndex=2).
    await rightClickMoveInDemo(page, 2);
    await page
      .locator('.review-context-menu')
      .getByTestId('nag-palette-variation-color-green')
      .click();
    // Палитра закрылась после выбора.
    await expect(popupPalette(page)).toHaveCount(0);
    // PGN в demo обновился.
    await expect(
      page.getByTestId('variation-color-demo-pgn'),
    ).toContainText('[%cvc G]');
    // Ждём throttle autosave (1500ms) + запас.
    await page.waitForTimeout(1700);
    const stored = await readAutosavePgn(page);
    expect(stored).not.toBeNull();
    expect(stored!).toContain('[%cvc G]');
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/03-after-green-cvc-g-in-pgn.png`,
      fullPage: true,
    });
  });

  test('clear → нет [%cvc] в PGN', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop');
    await gotoDemo(page);
    // Сначала ставим green.
    await rightClickMoveInDemo(page, 2);
    await page
      .locator('.review-context-menu')
      .getByTestId('nag-palette-variation-color-green')
      .click();
    await expect(
      page.getByTestId('variation-color-demo-pgn'),
    ).toContainText('[%cvc G]');
    // Теперь Clear.
    await rightClickMoveInDemo(page, 2);
    await page
      .locator('.review-context-menu')
      .getByTestId('nag-palette-variation-color-clear')
      .click();
    await expect(popupPalette(page)).toHaveCount(0);
    // PGN в demo больше не содержит макрос.
    const pgnText = await page
      .getByTestId('variation-color-demo-pgn')
      .textContent();
    expect(pgnText ?? '').not.toContain('[%cvc');
    // Throttle + проверка autosave.
    await page.waitForTimeout(1700);
    const stored = await readAutosavePgn(page);
    expect(stored).not.toBeNull();
    expect(stored!).not.toContain('[%cvc');
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/04-after-clear-no-cvc-in-pgn.png`,
      fullPage: true,
    });
  });
});
