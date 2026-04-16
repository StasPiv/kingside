const { chromium } = require('/project/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const consoleLogs = [];
  page.on('console', msg => {
    const txt = msg.text();
    consoleLogs.push(`[${msg.type()}] ${txt}`);
    if (txt.toLowerCase().includes('bot') || txt.toLowerCase().includes('stockfish') || 
        txt.toLowerCase().includes('engine') || txt.toLowerCase().includes('[bot]') ||
        msg.type() === 'error') {
      console.log(`[BROWSER ${msg.type()}]`, txt.slice(0, 400));
    }
  });
  page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));
  page.on('response', r => {
    if (r.url().includes('/api/games') && r.request().method() === 'POST') {
      console.log('[API]', r.request().method(), r.url(), '->', r.status());
    }
  });

  const resp = await fetch('http://localhost:3001/api/auth/dev-bypass', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'secret', user: 'tester' }),
  });
  const tokens = await resp.json();

  await page.goto('http://localhost:5174/');
  await page.evaluate((t) => { localStorage.setItem('token', t); }, tokens.accessToken);
  await page.goto('http://localhost:5174/play', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Раскрываем бот-секцию
  await page.locator('.play-card__header').filter({ hasText: 'Bot' }).click();
  await page.waitForTimeout(500);

  // Чёрный цвет — бот белыми ходит первым
  await page.locator('.color-btn--black').click();
  await page.waitForTimeout(300);

  // Level 3 уже по умолчанию, оставим
  await page.screenshot({ path: '/tmp/KS-1545/bot-setup.png', fullPage: true });

  // Жмём "Play Bot" в body — откроется TC modal
  await page.locator('.play-card__body--open button.play-btn').click();
  await page.waitForTimeout(500);
  console.log('TC modal opened');

  // В модалке жмём Blitz (по умолчанию уже активен) и Play Bot
  await page.locator('.bot-tc-modal .tc-btn').filter({ hasText: /Blitz|blitz/i }).click();
  await page.waitForTimeout(200);
  
  console.log('--- Clicking Play Bot in modal ---');
  await page.locator('.bot-tc-modal button.play-btn').click();
  await page.waitForTimeout(3000);
  console.log('URL after Play Bot:', page.url());
  await page.screenshot({ path: '/tmp/KS-1545/after-play-bot.png', fullPage: true });

  // Если мы на странице игры — дождёмся ходов
  if (page.url().includes('/game/')) {
    console.log('--- On game page, waiting for moves (up to 25s) ---');
    let lastMovesTxt = '';
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(1000);
      const movesEl = await page.locator('[class*="moves"]').first();
      const txt = await movesEl.textContent().catch(() => '');
      if (txt && txt.trim() && txt !== lastMovesTxt) {
        console.log(` [${i+1}s] moves:`, txt.slice(0, 200));
        lastMovesTxt = txt;
      }
    }
    await page.screenshot({ path: '/tmp/KS-1545/bot-game-after-wait.png', fullPage: true });

    // Проверим историю ходов
    const movesFull = await page.locator('body').textContent();
    require('fs').writeFileSync('/tmp/KS-1545/page-content.txt', movesFull.slice(0, 3000));
  } else {
    console.log('Not on game page. Current URL:', page.url());
    const btxt = await page.locator('body').textContent();
    console.log('Body text (first 300):', btxt.slice(0, 300));
  }

  require('fs').writeFileSync('/tmp/KS-1545/browser-logs.txt', consoleLogs.join('\n'));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
