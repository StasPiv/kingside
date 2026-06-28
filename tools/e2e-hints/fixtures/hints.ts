/**
 * KS-4763. Helpers для проверки появления/отсутствия popover'а.
 *
 * Селекторы — `[data-hint-popover][data-hint-key="<key>"]`. Атрибуты
 * расставлены в `apps/web/src/components/hints/HintHost.tsx` (правка
 * KS-4763 → подзадача frontend).
 *
 * Race-проблема: для авторизованного user'а hint доставляется через WS
 * `messagesSocket('/messages')`. Полный flow:
 *   1. page.goto → React mount → AuthProvider.fetchMe →
 *      HintHost effect → messagesSocket.connect() → join room user:<id>.
 *   2. Anchor element появляется в DOM по ходу рендера страницы
 *      (LobbyPage, PuzzleBrowserPage, …).
 *   3. emit-hint → backend `HintsService.checkFor` →
 *      `gateway.emitHintShow(actor.id, payload)`.
 *   4. Frontend `HintHost.useLayoutEffect` ищет
 *      `[data-hint-anchor="<key>"]`; если не нашёл — отправляет
 *      `ignored{no_anchor}`, и `HintsService.checkFor` при следующем
 *      вызове вернёт `null` (cooldown/maxShows).
 *
 * `triggerHintAndExpect` решает race так:
 *   - ждёт пока `data-hint-anchor` появится на странице (то есть DOM
 *     готов и подмонтирован anchor-узел);
 *   - даёт фронту короткий буфер на ws-join;
 *   - делает ОДИН `/test/emit-hint` — если backend выберет hint,
 *     fall-back-цикл прекратит retry, потому что cooldown активируется
 *     после первого ws-emit и второй вызов вернёт null.
 *   - ждёт popover на достаточном timeout (default 18 сек), чтобы
 *     успеть подхватить и WS-push (user), и pull-loop (guest, 15с).
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { ActorRef } from './actor';
import { emitHint, triggerGuestPageView } from './actor';

/** Anchor-карта по ключу правила. Заполнять при добавлении новых hints. */
const ANCHOR_BY_KEY: Record<string, string> = {
  'puzzle-comeback-after-week': 'home-puzzles-tile',
  'home-idle-suggest-puzzles': 'home-puzzles-tile',
  'discover-puzzle-rush': 'puzzles-rush-tab',
  'rush-streak-recovery': 'puzzles-rush-tab',
  'mistakes-diary-after-failures': 'profile-mistakes-link',
  'hint-overuse-mistakes-diary': 'profile-mistakes-link',
  'bridge-promo-after-3-wasm': 'analysis-bridge-promo',
  'guest-register-prompt': 'landing-signup-button',
  'guest-play-friction': 'landing-signup-button',
  'guest-try-puzzles': 'landing-puzzles-tile',
  'guest-features-discovery': 'landing-features-block',
  'analyze-after-loss': 'game-end-analysis-button',
};

/**
 * KS-4763. Полный сценарий «появись, подсказка»:
 *   1. дождаться anchor element'а в DOM (иначе HintHost ignore'нет push);
 *   2. короткий буфер на ws-join messagesSocket'а;
 *   3. один emit-hint;
 *   4. ждать popover c default timeout 18 сек (включая 15с pull-period
 *      для гостя).
 *
 * Используй ВМЕСТО ручного `await emitHint(...); await expectHintShown(...);`.
 */
export async function expectHintAppearsAfterEmit(
  page: Page,
  request: APIRequestContext,
  actor: ActorRef,
  pagePath: string,
  hintKey: string,
  opts: { timeoutMs?: number; anchorWaitMs?: number; wsJoinBufferMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 18_000;
  const anchorWaitMs = opts.anchorWaitMs ?? 10_000;
  const wsJoinBufferMs = opts.wsJoinBufferMs ?? 1_500;
  const anchor = ANCHOR_BY_KEY[hintKey];
  if (!anchor) {
    throw new Error(
      `expectHintAppearsAfterEmit: неизвестный hintKey "${hintKey}" — добавь в ANCHOR_BY_KEY в fixtures/hints.ts`,
    );
  }

  // 1. anchor element должен появиться в DOM, иначе HintHost проигнорирует.
  // state: 'attached' (не 'visible'): HintRenderer делает querySelector +
  // useFloating, не требует visibility-проверки. Многие anchor'ы (например
  // landing-signup-button в CTA-footer) лежат вне начального viewport.
  await page
    .locator(`[data-hint-anchor="${anchor}"]`)
    .first()
    .waitFor({ state: 'attached', timeout: anchorWaitMs });

  // 2a. Для user: дождаться `/auth/me` — после ответа AuthContext
  //     устанавливает `user`, HintHost effect (зависит от isAuthorized)
  //     подключает messagesSocket и подписывается на `hint:show`. Без
  //     этого emit-hint улетит в пустую room user:<id>.
  if (actor.type === 'user') {
    try {
      await page.waitForResponse(
        (res) => res.url().includes('/auth/me') && res.status() === 200,
        { timeout: 8_000 },
      );
    } catch {
      // если AuthContext уже отрезолвил до waitForResponse — пропускаем,
      // буфер ниже всё равно даст время на ws-join.
    }
  }

  // 2b. короткий буфер на ws-join (user) или first pull (guest).
  await page.waitForTimeout(wsJoinBufferMs);

  // 3. триггер. Для user — /test/emit-hint (ws-emit). Для guest — реальный
  //    `POST /events` page_view (HintsListener RPUSH'ит в pending; emit-hint
  //    для гостя на момент KS-4763 не RPUSH'ит — backend bug).
  let emit: { key: string | null; emitted: boolean } | null = null;
  if (actor.type === 'guest') {
    await triggerGuestPageView(request, pagePath);
  } else {
    emit = await emitHint(request, actor, pagePath);
  }

  // 4. ждать popover.
  await expect(
    page.locator(`[data-hint-popover][data-hint-key="${hintKey}"]`),
    `hint "${hintKey}" should appear within ${timeoutMs}ms (emit-hint: ${JSON.stringify(emit)})`,
  ).toBeVisible({ timeout: timeoutMs });
}

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
