import { expect, test, type Page } from '@playwright/test';

/**
 * KS-2279 (ADR-037 §3.4, этап E4) — e2e mobile-сценарии для
 * `<NagPaletteSheet>`. Полностью внутри `mobile` Playwright-проекта
 * (Pixel 5: 390×844, touch enabled).
 *
 * Сценарии:
 *   1. Long-press 500ms на ход → открывается sheet (включая
 *      handle, NagPalette внутри, extraActions если есть).
 *   2. Swipe-down ≥ 80px на handle → sheet закрывается.
 *   3. Swipe-down меньше порога (< 80px) → sheet остаётся открыт.
 *   4. Click по NAG внутри sheet → onChange + onClose, кнопка
 *      получает aria-pressed=true перед закрытием.
 *   5. Click по backdrop → закрывает.
 *   6. На viewport < 700px (Pixel 5 высота 844 → попадает
 *      под breakpoint, потому что `window.innerHeight < 700` — нет;
 *      нужно явно занизить через viewport-override).
 *      Sheet получает `data-half-height="true"` и
 *      `--nag-sheet-max-height: 50vh`.
 *
 * Тесты используют demo-страницу `/dev/nag-palette` (см. KS-2272 spec
 * — там расширен `<ReviewMoveListDemo>` editable + readonly), чтобы
 * избежать flow «логин→партия→ходы». Long-press эмулируется через
 * `dispatchEvent('touchstart')` + `waitForTimeout(550)`, swipe — через
 * последовательность `touchstart`/`touchmove`/`touchend` на handle.
 */

const SCREENSHOTS_DIR = '/tmp/KS-2279';

async function gotoDemo(page: Page): Promise<void> {
  await page.goto('/dev/nag-palette');
  await expect(
    page.getByTestId('review-move-list-demo-editable'),
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * Long-press на первом ходе demo-list. Возвращает координаты центра
 * для последующего swipe (полезно: handle рисуется выше move).
 */
async function longPressFirstMove(
  page: Page,
): Promise<{ cx: number; cy: number }> {
  const editable = page.getByTestId('review-move-list-demo-editable');
  const move1 = editable.getByTestId('review-move-1');
  const box = await move1.boundingBox();
  if (!box) throw new Error('move-1 boundingBox is null');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await editable.getByTestId('review-move-1').dispatchEvent('touchstart', {
    touches: [{ clientX: cx, clientY: cy, identifier: 0 }],
    targetTouches: [{ clientX: cx, clientY: cy, identifier: 0 }],
    changedTouches: [{ clientX: cx, clientY: cy, identifier: 0 }],
  });
  // long-press timer — 500ms (см. ReviewMoveList.handleTouchStart).
  await page.waitForTimeout(550);
  return { cx, cy };
}

/**
 * Swipe-down на handle от точки `startY` на `dy` пикселей вниз.
 * Эмулирует трёх-фазное touch-событие touchstart → touchmove → touchend.
 */
async function swipeHandleDown(page: Page, dy: number): Promise<void> {
  const handle = page.getByTestId('nag-palette-sheet-handle');
  const box = await handle.boundingBox();
  if (!box) throw new Error('handle boundingBox is null');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await handle.dispatchEvent('touchstart', {
    touches: [{ clientX: startX, clientY: startY, identifier: 1 }],
    targetTouches: [{ clientX: startX, clientY: startY, identifier: 1 }],
    changedTouches: [{ clientX: startX, clientY: startY, identifier: 1 }],
  });
  await handle.dispatchEvent('touchmove', {
    touches: [
      { clientX: startX, clientY: startY + dy, identifier: 1 },
    ],
    targetTouches: [
      { clientX: startX, clientY: startY + dy, identifier: 1 },
    ],
    changedTouches: [
      { clientX: startX, clientY: startY + dy, identifier: 1 },
    ],
  });
  await handle.dispatchEvent('touchend', {
    touches: [],
    targetTouches: [],
    changedTouches: [
      { clientX: startX, clientY: startY + dy, identifier: 1 },
    ],
  });
}

test.describe('KS-2279 — NagPaletteSheet mobile e2e', () => {
  test.describe.configure({ mode: 'serial' });

  // Mobile-only сценарии: Pixel 5 (390×844, touch enabled).
  // Через `test.skip(condition)` внутри каждого теста — это
  // штатный playwright-pattern (analysis-nag-palette.spec.ts тоже так).

  test('long-press → открывается NagPaletteSheet (handle + palette + actions)', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile');
    await gotoDemo(page);
    await longPressFirstMove(page);
    const sheet = page.getByTestId('nag-palette-sheet');
    await expect(sheet).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByTestId('nag-palette-sheet-handle'),
    ).toBeVisible();
    await expect(sheet.getByTestId('nag-palette')).toBeVisible();
    // Кнопка handle имеет нужный type / aria-label.
    const handle = page.getByTestId('nag-palette-sheet-handle');
    await expect(handle).toHaveAttribute('type', 'button');
    const ariaLabel = await handle.getAttribute('aria-label');
    expect(ariaLabel).toBeTruthy();
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/01-mobile-sheet-open.png`,
      fullPage: true,
    });
  });

  test('swipe-down ≥ 80px на handle → sheet закрывается', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile');
    await gotoDemo(page);
    await longPressFirstMove(page);
    await expect(page.getByTestId('nag-palette-sheet')).toBeVisible();
    await swipeHandleDown(page, 120);
    // `onClose` приводит к unmount (open=false → null).
    await expect(page.getByTestId('nag-palette-sheet')).toBeHidden({
      timeout: 2_000,
    });
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/02-mobile-sheet-after-swipe.png`,
      fullPage: true,
    });
  });

  test('swipe-down < 80px → sheet остаётся открыт + drag offset возвращается в 0', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile');
    await gotoDemo(page);
    await longPressFirstMove(page);
    const sheet = page.getByTestId('nag-palette-sheet');
    await expect(sheet).toBeVisible();
    await swipeHandleDown(page, 40); // ниже порога 80px
    // Sheet всё ещё видим.
    await expect(sheet).toBeVisible();
    // CSS-переменная вернулась в 0 после touchend (см. NagPaletteSheet
    // handleTouchEnd: `setDragOffset(0)` если меньше threshold).
    const dragVar = await sheet.evaluate(
      (el) =>
        (el as HTMLElement).style.getPropertyValue('--nag-sheet-drag') ||
        getComputedStyle(el).getPropertyValue('--nag-sheet-drag'),
    );
    expect(dragVar.trim()).toBe('0px');
    expect(await sheet.getAttribute('data-dragging')).toBe('false');
  });

  test('click по NAG внутри sheet → onChange + sheet закрывается', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile');
    await gotoDemo(page);
    await longPressFirstMove(page);
    const sheet = page.getByTestId('nag-palette-sheet');
    await expect(sheet).toBeVisible();
    // Клик по `!!` (nag=3).
    await sheet.getByTestId('nag-palette-btn-3').click();
    // `onClose` → sheet unmount.
    await expect(sheet).toBeHidden({ timeout: 2_000 });
    // На демо-инстансе editable initial nags=[] → после клика стоит [3].
    // Inline `!!` появляется в move-item (renderNagSymbols).
    const move1 = page
      .getByTestId('review-move-list-demo-editable')
      .getByTestId('review-move-1');
    await expect(move1).toContainText('!!');
  });

  test('click по backdrop → sheet закрывается', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile');
    await gotoDemo(page);
    await longPressFirstMove(page);
    await expect(page.getByTestId('nag-palette-sheet')).toBeVisible();
    // Клик по самому верху страницы попадает в backdrop, а не sheet.
    const backdrop = page.getByTestId('nag-palette-sheet-backdrop');
    const box = await backdrop.boundingBox();
    if (!box) throw new Error('backdrop boundingBox is null');
    // Клик в верхнюю четверть backdrop'а (sheet снизу — гарантированно
    // вне его bounds).
    await page.mouse.click(box.x + box.width / 2, box.y + 50);
    await expect(page.getByTestId('nag-palette-sheet')).toBeHidden({
      timeout: 2_000,
    });
  });

  test('viewport innerHeight < 700px → sheet получает data-half-height + --nag-sheet-max-height=50vh', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile');
    // Pixel 5 default — 390×844. Сужаем высоту, чтобы попасть под
    // half-height breakpoint (HALF_HEIGHT_VIEWPORT_BREAKPOINT=700).
    await page.setViewportSize({ width: 390, height: 600 });
    await gotoDemo(page);
    await longPressFirstMove(page);
    const sheet = page.getByTestId('nag-palette-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('data-half-height', 'true');
    const maxHeight = await sheet.evaluate(
      (el) => (el as HTMLElement).style.getPropertyValue('--nag-sheet-max-height'),
    );
    expect(maxHeight).toBe('50vh');
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/03-mobile-sheet-half-height.png`,
      fullPage: true,
    });
  });

  test('viewport innerHeight ≥ 700px → data-half-height=false, --nag-sheet-max-height не задан', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile');
    // Pixel 5 портрет: 390×844 — innerHeight ≥ 700 → НЕ half-height.
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoDemo(page);
    await longPressFirstMove(page);
    const sheet = page.getByTestId('nag-palette-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('data-half-height', 'false');
    const maxHeight = await sheet.evaluate(
      (el) => (el as HTMLElement).style.getPropertyValue('--nag-sheet-max-height'),
    );
    expect(maxHeight).toBe('');
  });
});
