// KS-4077 — снимок модалки окончания партии (game-result-modal) на десктопе и мобильном.
// Чтобы не разыгрывать реальную партию, инжектим в DOM открытой страницы
// разметку модалки с теми же классами, что использует GamePage.tsx
// (см. .game-result-modal-overlay → .result-modal-actions → .result-btn).
// Подписи кнопок берём те же, что в трекерной задаче.

import { chromium } from '/project/node_modules/playwright-core/index.mjs';

const CHROME = '/home/agent/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const URL = 'http://localhost:5173/?dev_bypass=kingside-dev-bypass-2026';

const MODAL_HTML = `
<div class="game-result-modal-overlay" id="ks4077-mock">
  <div class="game-result-modal">
    <div class="result-modal-header win">
      <h2>Победа</h2>
    </div>
    <div class="result-modal-body">
      <p class="result-modal-detail">Победа белых</p>
      <div class="result-modal-rating">
        <span class="rating-label">Рейтинг</span>
        <div class="rating-change-display">
          <span class="rating-before">1450</span>
          <span class="rating-arrow">→</span>
          <span class="rating-after">1462</span>
          <span class="rating-diff positive">+12</span>
        </div>
      </div>
    </div>
    <div class="result-modal-actions">
      <button class="result-btn">Реванш</button>
      <a class="result-btn" href="#">Новая партия</a>
      <button class="result-btn result-btn-primary">Открыть в анализе</button>
      <a class="result-btn" href="#">На главную</a>
    </div>
  </div>
</div>`;

async function snap(viewport, outPath) {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.evaluate((html) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstElementChild);
  }, MODAL_HTML);
  await page.waitForTimeout(300);
  await page.screenshot({ path: outPath, fullPage: false });
  await browser.close();
  console.log('saved', outPath);
}

await snap({ width: 1920, height: 1200 }, '/tmp/KS-4077/desktop-1920.png');
await snap({ width: 390, height: 844 },  '/tmp/KS-4077/mobile-390.png');
