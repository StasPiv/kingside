/**
 * KS-4174 (ADR-128 §7.6.1.3). Генератор статических og:image-картинок
 * 1200×630 для соц-превью.
 *
 * Каждый раздел сайта получает свою картинку: общий «Kingside»-логотип
 * слева, эмодзи-метафора и подпись раздела справа, плотный градиентный
 * фон в фирменной палитре. Дизайн намеренно лаконичный — задача
 * автоматизации, не художественной графики.
 *
 * Запуск (из корня репо):
 *   node apps/web/scripts/generate-og-images.mjs
 *
 * Что делает:
 *   1. Запускает headless Chromium через playwright.
 *   2. Для каждого описанного сюжета грузит HTML-шаблон (inline через
 *      `page.setContent`) и снимает PNG ровно 1200×630.
 *   3. Сохраняет результат в `apps/web/public/og/<name>.png`.
 *
 * Скрипт идемпотентен — повторный запуск даёт побайтово такие же
 * картинки (фиксированный шрифт, фиксированный градиент, без рандома).
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'public', 'og');

const WIDTH = 1200;
const HEIGHT = 630;

/**
 * 8 сюжетов из задачи. `from`/`to` — углы линейного градиента (HSL
 * соответствует основной тёмно-синей/фиолетовой палитре сайта),
 * `emoji` — крупная метафора в правой части картинки, `heading` —
 * подпись раздела крупно, `subheading` — пояснение мелко.
 */
const SCENES = [
  {
    file: 'landing',
    heading: 'Play. Train. Watch.',
    subheading: 'Online chess platform',
    emoji: '♟️',
    from: '#1a1a2e',
    to: '#3b3b6d',
  },
  {
    file: 'broadcast',
    heading: 'Live chess broadcasts',
    subheading: 'Watch tournaments in real time',
    emoji: '📺',
    from: '#1a1a2e',
    to: '#005277',
  },
  {
    file: 'tournament',
    heading: 'Tournaments',
    subheading: 'Crosstables, pairings, results',
    emoji: '🏆',
    from: '#1a1a2e',
    to: '#6d4a1a',
  },
  {
    file: 'player',
    heading: 'Player profile',
    subheading: 'Ratings, games, statistics',
    emoji: '👤',
    from: '#1a1a2e',
    to: '#4a3b6d',
  },
  {
    file: 'coach',
    heading: 'Coach profile',
    subheading: 'Lessons, schedule, reviews',
    emoji: '🎓',
    from: '#1a1a2e',
    to: '#52286d',
  },
  {
    file: 'lecture',
    heading: 'Lectures',
    subheading: 'Watch and learn from coaches',
    emoji: '📚',
    from: '#1a1a2e',
    to: '#6d2828',
  },
  {
    file: 'archive',
    heading: 'Game archive',
    subheading: 'Search master games by position',
    emoji: '🗄️',
    from: '#1a1a2e',
    to: '#28526d',
  },
  {
    file: 'default',
    heading: 'Kingside',
    subheading: 'Online chess platform',
    emoji: '♚️',
    from: '#1a1a2e',
    to: '#3b3b6d',
  },
];

function html(scene) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans",
      "Helvetica Neue", Arial, "Apple Color Emoji", "Noto Color Emoji",
      "Segoe UI Emoji", sans-serif;
    color: #f5f5fa;
    -webkit-font-smoothing: antialiased;
    background:
      radial-gradient(circle at 80% 20%, rgba(255,255,255,0.08), transparent 50%),
      linear-gradient(135deg, ${scene.from} 0%, ${scene.to} 100%);
    overflow: hidden;
  }
  .canvas {
    position: relative;
    width: 100%;
    height: 100%;
    padding: 64px 80px;
    display: grid;
    grid-template-rows: auto 1fr auto;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 40px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .brand .mark {
    width: 56px;
    height: 56px;
    border-radius: 14px;
    background: #f0c044;
    color: #1a1a2e;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 40px;
    font-weight: 800;
  }
  .content {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 48px;
    padding-top: 24px;
  }
  .text {
    max-width: 720px;
  }
  .heading {
    font-size: 84px;
    line-height: 1.05;
    font-weight: 800;
    letter-spacing: -0.01em;
    margin: 0 0 24px 0;
    color: #ffffff;
    word-break: break-word;
  }
  .subheading {
    font-size: 36px;
    color: rgba(245,245,250,0.78);
    line-height: 1.3;
    margin: 0;
  }
  .emoji {
    font-size: 280px;
    line-height: 1;
    filter: drop-shadow(0 6px 24px rgba(0,0,0,0.4));
  }
  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 28px;
    color: rgba(245,245,250,0.7);
    letter-spacing: 0.04em;
  }
  .footer .url { font-weight: 600; }
</style>
</head>
<body>
  <div class="canvas">
    <div class="brand">
      <span class="mark">K</span>
      <span>Kingside</span>
    </div>
    <div class="content">
      <div class="text">
        <h1 class="heading">${escapeHtml(scene.heading)}</h1>
        <p class="subheading">${escapeHtml(scene.subheading)}</p>
      </div>
      <div class="emoji">${scene.emoji}</div>
    </div>
    <div class="footer">
      <span class="url">kingside.site</span>
      <span>Online chess</span>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    args: ['--font-render-hinting=none'],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
    });
    for (const scene of SCENES) {
      await page.setContent(html(scene), { waitUntil: 'load' });
      // Дать раскрашенному эмодзи дорендериться (Noto Color Emoji).
      await page.evaluate(
        () => document.fonts && document.fonts.ready ? document.fonts.ready : null,
      );
      const buf = await page.screenshot({
        type: 'png',
        omitBackground: false,
        clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      });
      const out = resolve(OUT_DIR, `${scene.file}.png`);
      await writeFile(out, buf);
      console.log(`wrote ${out} (${buf.length} bytes)`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
