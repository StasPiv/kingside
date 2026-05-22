/**
 * KS-3238: рендер PWA-иконок (192/512/180/maskable-512) из оригинального
 * apps/web/public/icon.svg через chromium headless (playwright).
 *
 * Почему chromium, а не ImageMagick / rsvg-convert / inkscape:
 *   - ImageMagick 6 на dev-машине НЕ рендерит text-emoji `♔` из SVG —
 *     для chess-glyph'а внутри `<text>` без font-stack делается пустой
 *     прямоугольник (см. KS-3237 регрессия).
 *   - rsvg-convert / inkscape на dev-машине не установлены.
 *   - playwright + chromium есть как dev-зависимость, рендерит SVG как
 *     полноценный браузер с системным serif-шрифтом (DejaVu Serif) —
 *     ♔ отрисовывается корректно.
 *
 * Запуск (из корня репо или apps/web):
 *   node apps/web/scripts/render-pwa-icons.cjs
 *
 * Источник `apps/web/public/icon.svg` НЕ модифицируется. Maskable-512
 * получает 64px padding и #1a1a2e background (safe-zone ~75% по спеке
 * web.dev/maskable-icon), сам SVG-glyph остаётся идентичным.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ICON_SVG_PATH = path.join(REPO_ROOT, 'public/icon.svg');
const OUT_DIR = path.join(REPO_ROOT, 'public/icons');

const ICON_SVG = fs.readFileSync(ICON_SVG_PATH, 'utf-8');

function buildHtml({ size, padding = 0, bg = 'transparent' }) {
  const innerSize = size - padding * 2;
  return `<!doctype html>
<html><head><style>
  html, body { margin: 0; padding: 0; background: ${bg}; }
  body {
    width: ${size}px;
    height: ${size}px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  svg { width: ${innerSize}px; height: ${innerSize}px; display: block; }
</style></head>
<body>${ICON_SVG}</body>
</html>`;
}

async function renderTo(file, opts) {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({
      viewport: { width: opts.size, height: opts.size },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    await page.setContent(buildHtml(opts), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const buf = await page.screenshot({
      type: 'png',
      omitBackground: opts.bg === 'transparent',
      clip: { x: 0, y: 0, width: opts.size, height: opts.size },
    });
    const out = path.join(OUT_DIR, file);
    fs.writeFileSync(out, buf);
    console.log(`wrote ${out} (${buf.length} bytes)`);
  } finally {
    await browser.close();
  }
}

(async () => {
  await renderTo('icon-512.png', { size: 512 });
  await renderTo('icon-192.png', { size: 192 });
  await renderTo('icon-180.png', { size: 180 });
  await renderTo('icon-512-maskable.png', {
    size: 512,
    padding: 64,
    bg: '#1a1a2e',
  });
})();
