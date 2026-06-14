#!/usr/bin/env node
/**
 * KS-3684. Playwright-проба для тестовой страницы `/dev/sf-trace-test`.
 *
 * Использование:
 *   1. Локальный сервер с COOP/COEP запущен (tools/sf-trace-local-server.mjs).
 *   2. node /project/tools/sf-trace-probe.mjs [channel] [fen]
 *      где channel = postMessage | _uci_command | ccall | cwrap | all
 *      (по умолчанию ccall), fen — произвольный FEN (по умолчанию startpos).
 *
 * Сохраняет в /tmp/KS-3684/probe-<channel>-<ts>.json: логи и результат.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const SECRET = process.env.SF_TRACE_BYPASS ?? 'kingside-dev-bypass-2026';
const SERVER = process.env.SF_TRACE_SERVER ?? 'http://localhost:4180';
// Полный chromium, не headless-shell — headless-shell иногда крашится
// на multi-threaded WASM (SharedArrayBuffer + pthread-pool).
const CHROME =
  process.env.SF_TRACE_CHROME ??
  '/home/agent/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';

const channel = process.argv[2] ?? 'ccall';
const fen =
  process.argv[3] ??
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const OUT = '/tmp/KS-3684';
mkdirSync(OUT, { recursive: true });

const log = (m) => console.log(`[probe] ${m}`);

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: [
    '--enable-features=SharedArrayBuffer',
    '--no-sandbox',
    '--disable-setuid-sandbox',
  ],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const consoleLines = [];
page.on('console', (msg) => {
  consoleLines.push(`[${msg.type()}] ${msg.text()}`);
});
page.on('pageerror', (err) => consoleLines.push(`[pageerror] ${err.message}`));

// dev/sf-trace-test — публичный маршрут (/dev/*), auth не нужна, поэтому
// dev_bypass не передаём — иначе DevBypassPage упадёт без локального API.
const url = `${SERVER}/dev/sf-trace-test`;
void SECRET;
log(`open ${url}`);
await page.goto(url, { waitUntil: 'load', timeout: 30000 });

// Проверяем cross-origin isolation.
const isolated = await page.evaluate(() => ({
  crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated,
  sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
}));
log(`isolation: ${JSON.stringify(isolated)}`);

await page.locator('[data-testid="dev-sf-trace-test"]').waitFor({ timeout: 15000 });

if (fen) {
  await page.fill('[data-testid="sf-trace-fen"]', fen);
}
await page.selectOption('[data-testid="sf-trace-channel"]', channel);
log(`channel=${channel} fen=${fen}`);

await page.click('[data-testid="sf-trace-run"]');

// Ждём пока кнопка снова станет активной (run завершён).
await page
  .locator('[data-testid="sf-trace-run"]:not([disabled])')
  .waitFor({ timeout: 60000 })
  .catch(() => log('run button still disabled, continuing'));

const logsText = await page.locator('[data-testid="sf-trace-logs"]').innerText();
const resultText = await page.locator('[data-testid="sf-trace-result"]').innerText();
let resultJson = null;
try {
  resultJson = JSON.parse(resultText);
} catch {
  /* ignore */
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = `${OUT}/probe-${channel}-${stamp}.json`;
writeFileSync(
  file,
  JSON.stringify(
    {
      channel,
      fen,
      isolated,
      result: resultJson ?? resultText,
      uiLogs: logsText.split('\n'),
      consoleLines,
    },
    null,
    2,
  ),
);
log(`written ${file}`);
log(`subterms_count = ${resultJson?.jsonRaw?.subterms?.length ?? 'n/a'}`);
log(`error = ${resultJson?.error ?? 'none'}`);

await browser.close();
