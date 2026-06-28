/**
 * Правило: bridge-promo-after-3-wasm
 * Anchor:  analysis-bridge-promo (на /analysis*)
 * DSL:     3+ engine_started{source:wasm} за 30 дн, не было engine_started{source:bridge}
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, daysAgo } from '../fixtures/actor';
import { loginAs, TEST_USER } from '../fixtures/auth';
import { expectHintShown } from '../fixtures/hints';

test('bridge-promo показывается после 3 запусков wasm-движка', async ({
  context,
  request,
  page,
}) => {
  await cleanActor(request, TEST_USER);
  await loginAs(context, request, TEST_USER);

  // 3 запуска wasm за прошлую неделю — условие count.gte=3 за 30 дней.
  await seedEvents(request, TEST_USER, [
    { type: 'engine_started', payload: { source: 'wasm' }, created_at: daysAgo(7) },
    { type: 'engine_started', payload: { source: 'wasm' }, created_at: daysAgo(5) },
    { type: 'engine_started', payload: { source: 'wasm' }, created_at: daysAgo(2) },
  ]);

  // Заход на /analysis — reactive check на page_view выстреливает правило.
  await page.goto('/analysis');

  await expectHintShown(page, 'bridge-promo-after-3-wasm');
});

test('bridge-promo НЕ показывается, если уже был запуск через bridge', async ({
  context,
  request,
  page,
}) => {
  await cleanActor(request, TEST_USER);
  await loginAs(context, request, TEST_USER);

  await seedEvents(request, TEST_USER, [
    { type: 'engine_started', payload: { source: 'wasm' }, created_at: daysAgo(7) },
    { type: 'engine_started', payload: { source: 'wasm' }, created_at: daysAgo(5) },
    { type: 'engine_started', payload: { source: 'wasm' }, created_at: daysAgo(2) },
    // not.exists{source:bridge} — наличие отменяет правило.
    { type: 'engine_started', payload: { source: 'bridge' }, created_at: daysAgo(1) },
  ]);

  await page.goto('/analysis');

  const { expectHintNotShown } = await import('../fixtures/hints');
  await expectHintNotShown(page, 'bridge-promo-after-3-wasm');
});
