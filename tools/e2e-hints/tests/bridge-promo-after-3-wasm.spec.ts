/**
 * Правило: bridge-promo-after-3-wasm
 * Anchor:  analysis-bridge-promo (на /analysis*)
 * DSL:     3+ engine_started{source:wasm} за 30 дн, не было engine_started{source:bridge}
 *
 * KS-4784: REAL flow — кликаем «Старт» wasm-движка 3 раза на /analysis.
 * Frontend пошлёт track('engine_started',{source:'wasm'}); backend через
 * HintsListener реактивно дёрнет checkFor; popover приедет по WS.
 * Без /test/seed/events и без /test/emit-hint.
 */
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { cleanActor } from '../fixtures/actor';
import { loginAs, TEST_USER } from '../fixtures/auth';
import { expectHintShown, expectHintNotShown } from '../fixtures/hints';

// KS-4787: stdout playwright обрезается MCP-тулом до ~200 строк, CORS-flood
// от google fonts вымывает диагностику. Пишем полную ленту в файл внутри
// test-results — туда у QA-агента есть RW.
const KSDIAG_FILE = resolve(__dirname, '..', 'test-results', 'ks-diag-full.log');
function diagWrite(line: string): void {
  appendFileSync(KSDIAG_FILE, line + '\n');
}

// KS-4784: video:'on' — запись видео-подтверждения работы правила
// (по умолчанию в playwright.config.ts — retain-on-failure).
test.use({ video: 'on' });

test('bridge-promo показывается после 3 запусков wasm-движка', async ({
  context,
  request,
  page,
}) => {
  // KS-4787: ВСЁ пишем в файл (без обрезки и без фильтра), а в stdout —
  // только ключевые ks-diag/page_view/engine_started/HintHost/errors.
  mkdirSync(dirname(KSDIAG_FILE), { recursive: true });
  writeFileSync(KSDIAG_FILE, `=== prep: ${new Date().toISOString()} ===\n`);
  page.on('console', (msg) => {
    const text = msg.text();
    const type = msg.type();
    diagWrite(`[browser:${type}] ${text}`);
    const keep =
      type === 'error' ||
      /ks-diag|page_view|engine_started|HintHost|hint:show/i.test(text);
    if (!keep) return;
    // eslint-disable-next-line no-console
    console.log(`[browser:${type}] ${text}`);
  });
  page.on('pageerror', (err) => {
    diagWrite(`[pageerror] ${err.message}\n${err.stack ?? ''}`);
    // eslint-disable-next-line no-console
    console.log(`[pageerror] ${err.message}`);
  });
  page.on('request', (req) => {
    const url = req.url();
    if (/\/events(\/|\?|$)/.test(url) || /\/api\/events/.test(url)) {
      diagWrite(`[req] ${req.method()} ${url} body=${req.postData()?.slice(0, 300) ?? ''}`);
      // eslint-disable-next-line no-console
      console.log(`[req] ${req.method()} ${url}`);
    }
  });
  page.on('response', async (resp) => {
    const url = resp.url();
    if (/\/events(\/|\?|$)/.test(url) || /\/api\/events/.test(url)) {
      diagWrite(`[resp] ${resp.status()} ${url}`);
      // eslint-disable-next-line no-console
      console.log(`[resp] ${resp.status()} ${url}`);
    }
  });
  page.on('websocket', (ws) => {
    diagWrite(`[ws-open] ${ws.url()}`);
    // eslint-disable-next-line no-console
    console.log(`[ws-open] ${ws.url()}`);
    ws.on('framereceived', (frame) => {
      const payload =
        typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8');
      // KS-4787: в ks-diag-full.log пишем ВСЕ ws-фреймы (urgency для
      // диагностики доставки hint:show), в stdout — только с ключевыми
      // словами, чтобы не топить полезный вывод.
      diagWrite(`[ws<] ${payload.slice(0, 1000)}`);
      if (/hint|message|engine_started/i.test(payload)) {
        // eslint-disable-next-line no-console
        console.log(`[ws<] ${payload.slice(0, 500)}`);
      }
    });
    ws.on('framesent', (frame) => {
      const payload =
        typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8');
      diagWrite(`[ws>] ${payload.slice(0, 1000)}`);
      if (/hint|engine_started/i.test(payload)) {
        // eslint-disable-next-line no-console
        console.log(`[ws>] ${payload.slice(0, 500)}`);
      }
    });
  });

  await cleanActor(request, TEST_USER);
  await loginAs(context, request, TEST_USER);

  await page.goto('/analysis');

  const toggle = page.locator('[data-testid="stockfish-toggle"]').first();
  await toggle.waitFor({ state: 'visible', timeout: 15_000 });

  // 3 цикла Старт/Стоп — каждый «Старт» отправляет
  // track('engine_started',{source:'wasm'}) (см. AnalysisPage.tsx).
  for (let i = 0; i < 3; i++) {
    await expect(toggle, `клик #${i + 1}: ожидаю Start`).toHaveText(/Start|Старт/);
    await toggle.click();
    await expect(toggle, `клик #${i + 1}: после клика жду Stop`).toHaveText(/Stop|Стоп/);
    await toggle.click();
    await expect(toggle, `клик #${i + 1}: жду возврата в Start`).toHaveText(/Start|Старт/);
  }

  // Перезагрузка → page_view → HintsListener (REACTIVE_TYPES) → checkFor →
  // emit hint:show по WebSocket в room user:<id>.
  await page.goto('/analysis');

  await page
    .locator('[data-hint-anchor="analysis-bridge-promo"]')
    .first()
    .waitFor({ state: 'attached', timeout: 10_000 });

  await expectHintShown(page, 'bridge-promo-after-3-wasm', { timeout: 18_000 });
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

  await expectHintNotShown(page, 'bridge-promo-after-3-wasm');
});
