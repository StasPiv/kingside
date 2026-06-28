/**
 * Правило: bridge-promo-after-3-wasm
 * Anchor:  analysis-bridge-promo (на /analysis*)
 * DSL:     3+ engine_started{source:wasm} за 30 дн, не было engine_started{source:bridge}
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, daysAgo, emitHint } from '../fixtures/actor';
import { loginAs, TEST_USER } from '../fixtures/auth';
import { expectHintAppearsAfterEmit, expectHintNotShown } from '../fixtures/hints';

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

  await page.goto('/analysis');
  await expectHintAppearsAfterEmit(page, request, TEST_USER, '/analysis', 'bridge-promo-after-3-wasm');
});

// KS-4763: правило bridge-promo в test-стеке упрощено (убран `where:{source}`-фильтр
// из-за бага Prisma jsonPath string_equals — см. tools/seed-test-hints.sql).
// Negative-сценарий проверяет not-exists по source=bridge, который без where
// не различить от source=wasm → пропускаем до фикса DSL.
test.skip('bridge-promo НЕ показывается, если уже был запуск через bridge', async ({
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
  await emitHint(request, TEST_USER, '/analysis');

  await expectHintNotShown(page, 'bridge-promo-after-3-wasm');
});
