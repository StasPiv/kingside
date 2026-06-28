/**
 * KS-4763. Helpers для проверки появления/отсутствия popover'а.
 *
 * Селекторы — `[data-hint-popover][data-hint-key="<key>"]`. Атрибуты
 * расставлены в `apps/web/src/components/hints/HintHost.tsx` (правка
 * KS-4763 → подзадача frontend). До той правки селекторы развалятся.
 */
import { expect, type Page } from '@playwright/test';

/** Ждёт появления popover'а по ключу правила. Default-timeout 10 сек. */
export async function expectHintShown(
  page: Page,
  hintKey: string,
  opts: { timeout?: number } = {},
): Promise<void> {
  await expect(
    page.locator(`[data-hint-popover][data-hint-key="${hintKey}"]`),
    `hint "${hintKey}" should appear`,
  ).toBeVisible({ timeout: opts.timeout ?? 10_000 });
}

/**
 * Утверждает, что popover НЕ появится в течение `windowMs`. Используется
 * для негативных проверок (например, «правило не сработало, потому что
 * smart-dismiss событие уже было»). По умолчанию 3 секунды — достаточно,
 * чтобы reactive-check сервера и pull-loop успели отработать.
 */
export async function expectHintNotShown(
  page: Page,
  hintKey: string,
  windowMs: number = 3_000,
): Promise<void> {
  const locator = page.locator(`[data-hint-popover][data-hint-key="${hintKey}"]`);
  await page.waitForTimeout(windowMs);
  await expect(locator, `hint "${hintKey}" should NOT appear`).toHaveCount(0);
}

/** Утверждает, что любая подсказка не появилась в окне. */
export async function expectNoHint(page: Page, windowMs: number = 3_000): Promise<void> {
  await page.waitForTimeout(windowMs);
  await expect(page.locator('[data-hint-popover]')).toHaveCount(0);
}
