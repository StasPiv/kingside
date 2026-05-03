import { expect, test, type Page } from '@playwright/test';

/**
 * KS-2272 (ADR-037, этап E2) — e2e тесты палитры NAG в `ReviewMoveList`.
 *
 * Сценарии:
 *   1. Открытие палитры через right-click (desktop).
 *   2. Установка NAG → активная подсветка кнопки.
 *   3. Replace within group: `!` → `!!` оставляет только `!!`
 *      (без legacy-дублей `! !!`).
 *   4. Toggle off: повторный клик `!!` снимает NAG.
 *   5. Tooltip RU / EN — i18n работает (title-attribute меняется
 *      при смене locale).
 *   6. Read-only режим (`InlinePgnViewer` / ReviewMoveList с
 *      `readOnly`) — палитра НЕ открывается.
 *   7. Mobile long-press → bottom-sheet (`<NagPaletteSheet>`).
 *
 * Тесты опираются на demo-страницу `/dev/nag-palette` (доступна только
 * в dev-сборке через DevRoutes), которая монтирует:
 *   - `[data-testid="review-move-list-demo-editable"]` — обычный
 *     `<ReviewMoveList>` с `onSetNag`;
 *   - `[data-testid="review-move-list-demo-readonly"]` — тот же
 *     компонент с `readOnly`.
 * Это убирает зависимость e2e от полноценного flow (логин → создание
 * партии → ходы) — палитра тестируется в изоляции, но через настоящую
 * интеграцию `ReviewMoveList → NagPalette / NagPaletteSheet`.
 *
 * dev-сервер: `localhost:5173`. Аутентификация для dev-страниц
 * (`/dev/*`) не требуется (см. App.tsx — `lazy(import('./dev/DevRoutes'))`
 * подгружается без guard'ов в dev-сборке).
 */

const SCREENSHOTS_DIR = '/tmp/KS-2272';

async function setLocale(page: Page, lng: 'en' | 'ru'): Promise<void> {
  // i18next кэширует выбранную локаль в localStorage (`locale`), плюс
  // MainLayout patch'ит `/users/me/settings`. На dev-страницах
  // достаточно localStorage.
  await page.addInitScript((language) => {
    localStorage.setItem('locale', language);
  }, lng);
}

async function gotoDemo(page: Page): Promise<void> {
  await page.goto('/dev/nag-palette');
  await expect(
    page.getByTestId('review-move-list-demo-editable'),
  ).toBeVisible({ timeout: 15_000 });
}

async function rightClickFirstMove(page: Page): Promise<void> {
  const editable = page.getByTestId('review-move-list-demo-editable');
  await editable.getByTestId('review-move-1').click({ button: 'right' });
}

/**
 * KS-2272: на demo-странице рендерится 6 standalone-инстансов
 * `<NagPalette>` (для layout / визуальных проверок) — все имеют
 * `data-testid="nag-palette"`. Чтобы локатор не наталкивался на них,
 * палитра, открытая из ReviewMoveList по right-click, ВСЕГДА
 * вложена в `.review-context-menu` popup. Берём её точечно.
 */
function popupPalette(page: Page) {
  return page.locator('.review-context-menu').getByTestId('nag-palette');
}

function popupPaletteBtn(page: Page, nag: number) {
  return page
    .locator('.review-context-menu')
    .getByTestId(`nag-palette-btn-${nag}`);
}

function popupPaletteDelete(page: Page) {
  return page
    .locator('.review-context-menu')
    .getByTestId('nag-palette-delete');
}

test.describe('KS-2272 — analysis NagPalette e2e', () => {
  test.describe.configure({ mode: 'serial' });

  // ─── Desktop ────────────────────────────────────────────────────

  test('desktop: right-click → открывается NagPalette с 14 кнопками + delete', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Right-click — desktop trigger.',
    );
    await setLocale(page, 'en');
    await gotoDemo(page);
    await rightClickFirstMove(page);

    const palette = popupPalette(page);
    await expect(palette).toBeVisible();

    // 14 кнопок: quality 1..6 + positionEval 10/13..19.
    for (const nag of [1, 2, 3, 4, 5, 6, 10, 13, 14, 15, 16, 17, 18, 19]) {
      await expect(popupPaletteBtn(page, nag)).toBeVisible();
    }
    await expect(popupPaletteDelete(page)).toBeVisible();
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/01-desktop-palette-open.png`,
      fullPage: true,
    });
  });

  test('desktop: replace within quality (`!` → `!!`) и toggle off', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop');
    await setLocale(page, 'en');
    await gotoDemo(page);

    // 1) Установить NAG `!` (nag=1) на первый ход.
    await rightClickFirstMove(page);
    await popupPaletteBtn(page, 1).click();
    // Палитра закрывается после клика.
    await expect(popupPalette(page)).toHaveCount(0);
    const move1 = page
      .getByTestId('review-move-list-demo-editable')
      .getByTestId('review-move-1');
    await expect(move1).toContainText('!');

    // 2) Re-open палитру и поставить `!!` (nag=3) — replace within group.
    await rightClickFirstMove(page);
    // Активная подсветка `!` — кнопка nag-1 имеет aria-pressed.
    await expect(popupPaletteBtn(page, 1)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await popupPaletteBtn(page, 3).click();
    await expect(popupPalette(page)).toHaveCount(0);
    // На ходе теперь `!!`, без пары `! !!`.
    await expect(move1).toContainText('!!');
    expect(await move1.textContent()).not.toMatch(/!\s+!!/);

    // 3) Toggle off: повторный клик `!!`.
    await rightClickFirstMove(page);
    await expect(popupPaletteBtn(page, 3)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await popupPaletteBtn(page, 3).click();
    await expect(popupPalette(page)).toHaveCount(0);
    // NAG снят. renderNagSymbols показывает по одному NAG из категории —
    // после снятия quality-NAG inline-NAG не должен показывать ни `!`, ни `!!`.
    // Текст ход'а — `1.e4` (без `!`), потому что `!` идёт через
    // `<span class="review-nag">` после san. Проверяем отсутствие span'а.
    await expect(
      move1.locator('.review-nag').first(),
    ).toHaveCount(0);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/02-desktop-replace-toggle.png`,
      fullPage: true,
    });
  });

  test('desktop: tooltip EN на кнопках NAG', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop');
    await setLocale(page, 'en');
    await gotoDemo(page);
    await rightClickFirstMove(page);
    const expectedEn: Record<number, string> = {
      1: 'Good move',
      3: 'Brilliant move',
      4: 'Blunder',
      14: 'White is slightly better',
      18: 'White is winning',
    };
    for (const [nag, expected] of Object.entries(expectedEn)) {
      const btn = popupPaletteBtn(page, Number(nag));
      await expect(btn).toHaveAttribute('title', expected);
      await expect(btn).toHaveAttribute('aria-label', expected);
    }
  });

  test('desktop: tooltip RU на кнопках NAG (терминология Информатора)', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop');
    await setLocale(page, 'ru');
    await gotoDemo(page);
    await rightClickFirstMove(page);
    const expectedRu: Record<number, string> = {
      1: 'Хороший ход',
      3: 'Блестящий ход',
      4: 'Зевок',
      14: 'У белых чуть лучше',
      18: 'У белых выиграно',
    };
    for (const [nag, expected] of Object.entries(expectedRu)) {
      const btn = popupPaletteBtn(page, Number(nag));
      await expect(btn).toHaveAttribute('title', expected);
      await expect(btn).toHaveAttribute('aria-label', expected);
    }
  });

  test('desktop: read-only — right-click НЕ открывает палитру', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop');
    await setLocale(page, 'en');
    await gotoDemo(page);
    const readonly = page.getByTestId('review-move-list-demo-readonly');
    // У read-only `<ReviewMoveList readOnly>` нет триггера context-menu —
    // но проверим, что right-click не показывает popup.
    await readonly.getByTestId('review-move-1').click({ button: 'right' });
    // Должно остаться 0 popup-палитр и 0 sheet'ов (на странице есть
    // 6 standalone-палитр, поэтому глобальный getByTestId('nag-palette')
    // ≠ 0; проверяем именно popup-инстанс через .review-context-menu).
    await expect(popupPalette(page)).toHaveCount(0);
    await expect(page.getByTestId('nag-palette-sheet')).toHaveCount(0);
  });

  // ─── Mobile ─────────────────────────────────────────────────────

  test('mobile: long-press → открывается NagPaletteSheet (bottom-sheet)', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'mobile',
      'Long-press — mobile trigger.',
    );
    await setLocale(page, 'en');
    await gotoDemo(page);

    const editable = page.getByTestId('review-move-list-demo-editable');
    const move1 = editable.getByTestId('review-move-1');
    const box = await move1.boundingBox();
    if (!box) throw new Error('move-1 boundingBox is null');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // Touch-эмуляция: tap-down → ждём 600ms (long-press 500ms) → tap-up.
    await page.touchscreen.tap(cx, cy);
    // Single tap — это short tap, недостаточно. Сделаем long press
    // через CDP-команду dispatchTouchEvent → wait → end. У Playwright
    // touchscreen.tap = touchstart+touchend сразу. Чтобы реально
    // удержать палец, используем page.dispatchEvent.
    await editable
      .getByTestId('review-move-1')
      .dispatchEvent('touchstart', {
        touches: [{ clientX: cx, clientY: cy, identifier: 0 }],
        targetTouches: [{ clientX: cx, clientY: cy, identifier: 0 }],
        changedTouches: [{ clientX: cx, clientY: cy, identifier: 0 }],
      });
    await page.waitForTimeout(550);
    const sheet = page.getByTestId('nag-palette-sheet');
    await expect(sheet).toBeVisible({ timeout: 5_000 });
    // Внутри sheet — палитра NagPalette.
    await expect(sheet.getByTestId('nag-palette')).toBeVisible();
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/03-mobile-sheet-open.png`,
      fullPage: true,
    });
  });
});
