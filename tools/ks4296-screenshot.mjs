// KS-4296 — снимок страницы игры в альбомной ориентации на mobile.
// Делаем три скриншота:
//  1) landscape 700×400 (типичный мобильный landscape)
//  2) landscape 844×390 (iPhone 13 landscape)
//  3) portrait 390×844 (контроль — что не сломали)
//
// Чтобы получить «живые» данные на доске, играем несколько ходов
// в локально-ботовой партии (/play/local-bot — не требует backend).

import { chromium } from '/project/node_modules/playwright-core/index.mjs';
import { mkdirSync } from 'node:fs';

const CHROME = '/home/agent/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const BASE = 'http://localhost:5173/?dev_bypass=kingside-dev-bypass-2026';
const PLAY = 'http://localhost:5173/play/local-bot?dev_bypass=kingside-dev-bypass-2026';
const OUT = '/tmp/KS-4296';
mkdirSync(OUT, { recursive: true });

/**
 * Открывает /play/local-bot, ждёт появления .board-container, играет
 * первые ходы кликом по data-square; делает скриншот.
 */
async function snap({ width, height, name }) {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  // Грузим страницу с dev_bypass — sessionStorage/cookies встанут.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // Переходим в локально-ботовую игру.
  await page.goto(PLAY, { waitUntil: 'domcontentloaded' });

  // Ждём появления доски.
  await page.waitForSelector('.board-container', { timeout: 15000 });
  await page.waitForTimeout(800);

  // Имитируем `/game/<id>` — там MainLayout прячет .mobile-bottom-bar.
  // На /play/local-bot он остаётся, перекрывая action-bar/доску и сбивая
  // визуальную приёмку. Скрываем через инъекцию стилей.
  await page.addStyleTag({
    content: '.mobile-bottom-bar { display: none !important; }',
  });
  await page.waitForTimeout(300);

  // Пробуем сыграть пару ходов, чтобы на доске и в move-strip
  // были реальные данные. Если не получается — снимаем как есть
  // (acceptance задачи — раскладка, а не сами ходы).
  const playMove = async (from, to) => {
    try {
      await page.locator(`[data-square="${from}"]`).first().click({ timeout: 1500 });
      await page.waitForTimeout(150);
      await page.locator(`[data-square="${to}"]`).first().click({ timeout: 1500 });
      await page.waitForTimeout(900);
    } catch {
      // ход не прошёл — пропускаем
    }
  };
  await playMove('e2', 'e4');
  await playMove('g1', 'f3');
  await playMove('f1', 'c4');
  await page.waitForTimeout(600);

  // Снимаем компьютед размеры для отладки.
  const debug = await page.evaluate(() => {
    const get = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        pad: cs.padding,
        gap: cs.gap,
        rowgap: cs.rowGap,
      };
    };
    return {
      vp: { w: window.innerWidth, h: window.innerHeight, dvh: window.visualViewport?.height },
      page: get('.game-page'),
      opp: get('.player-info.opponent-info'),
      board: get('.board-container'),
      self: get('.player-info.player-info-self'),
      moves: get('.game-move-strip'),
      action: get('.game-action-bar'),
    };
  });
  console.log(name, JSON.stringify(debug));

  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  console.log(`saved ${file}`);
  await browser.close();
}

await snap({ width: 700, height: 400, name: 'landscape-700x400' });
await snap({ width: 844, height: 390, name: 'landscape-844x390' });
await snap({ width: 390, height: 844, name: 'portrait-390x844' });
// Контроль desktop ≥900 — раскладка должна остаться прежней (sidebar справа).
await snap({ width: 1280, height: 800, name: 'desktop-1280x800' });

console.log('done');
