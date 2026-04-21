import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

/**
 * Read every stylesheet under `src/styles/*.css` and concatenate them into a
 * single string. `src/styles.css` used to be the aggregate; after the
 * refactor it only contains `@import` directives, so the tests that assert on
 * the CSS text need to read the source files directly.
 *
 * Files are sorted alphabetically and joined in that order. The mobile
 * overrides live in `responsive.css`, which sorts after every other file
 * that currently contains an `@media (max-width: 480px)` block
 * (`chat.css`, `layout.css`, `lobby.css`, `play.css`). That keeps
 * `css.lastIndexOf('@media (max-width: 480px)')` pointing at the block that
 * owns the rules under test.
 */
function loadAggregatedCss(): string {
  const stylesDir = resolve(__dirname, 'styles');
  return readdirSync(stylesDir)
    .filter((file) => file.endsWith('.css'))
    .sort()
    .map((file) => readFileSync(join(stylesDir, file), 'utf-8'))
    .join('\n');
}

/**
 * KS-263: Реверификация фикса KS-254 — мобильная вёрстка Puzzle Rush
 *
 * Статический анализ CSS: проверяем наличие необходимых правил
 * для корректного отображения на viewport 375px.
 */
describe('KS-254: мобильная вёрстка CSS', () => {
  const css = loadAggregatedCss();

  it('media query @media (max-width: 480px) существует', () => {
    expect(css).toContain('@media (max-width: 480px)');
  });

  it('.main имеет overflow-x: hidden для предотвращения горизонтального скролла', () => {
    // Ищем правило внутри media query
    const mobileSection = css.slice(css.lastIndexOf('@media (max-width: 480px)'));
    expect(mobileSection).toContain('overflow-x: hidden');
  });

  it('навигация имеет flex-wrap для корректного переноса', () => {
    const mobileSection = css.slice(css.lastIndexOf('@media (max-width: 480px)'));
    expect(mobileSection).toContain('flex-wrap: wrap');
  });

  it('.puzzle-rush-header имеет уменьшенный gap для мобильных', () => {
    const mobileSection = css.slice(css.lastIndexOf('@media (max-width: 480px)'));
    expect(mobileSection).toContain('.puzzle-rush-header');
    // gap должен быть меньше десктопного (32px → 16px)
    const headerIdx = mobileSection.indexOf('.puzzle-rush-header');
    const headerBlock = mobileSection.slice(headerIdx, headerIdx + 100);
    expect(headerBlock).toContain('gap: 16px');
  });

  it('.rush-time имеет уменьшенный шрифт для мобильных', () => {
    const mobileSection = css.slice(css.lastIndexOf('@media (max-width: 480px)'));
    expect(mobileSection).toContain('.rush-time');
    const timeIdx = mobileSection.indexOf('.rush-time');
    const timeBlock = mobileSection.slice(timeIdx, timeIdx + 100);
    expect(timeBlock).toContain('font-size: 24px');
  });

  it('.puzzle-rush-page имеет уменьшенный padding для мобильных', () => {
    const mobileSection = css.slice(css.lastIndexOf('@media (max-width: 480px)'));
    // Ищем именно .puzzle-rush-page { (без продолжения селектора)
    const regex = /\.puzzle-rush-page\s*\{[^}]*padding-top:\s*16px/;
    expect(mobileSection).toMatch(regex);
  });

  it('.puzzle-rush-page .board-container адаптивная ширина', () => {
    const mobileSection = css.slice(css.lastIndexOf('@media (max-width: 480px)'));
    expect(mobileSection).toContain('.puzzle-rush-page .board-container');
  });
});

/**
 * KS-388: Адаптивная вёрстка для мобильных устройств
 */
describe('KS-388: мобильная вёрстка страниц', () => {
  const css = loadAggregatedCss();

  it('game-actions button имеет min-height 44px на мобильных', () => {
    const mobileSection = css.slice(css.lastIndexOf('@media (max-width: 480px)'));
    expect(mobileSection).toContain('.game-actions button');
    // Find the rule specifically inside mobile media query
    expect(mobileSection).toContain('min-height: 44px');
  });

  it('.clock имеет font-size >= 20px на мобильных', () => {
    const mobileSection = css.slice(css.lastIndexOf('@media (max-width: 480px)'));
    const clockIdx = mobileSection.indexOf('.clock');
    const clockBlock = mobileSection.slice(clockIdx, clockIdx + 100);
    // should be 22px, not the old 18px
    expect(clockBlock).toContain('font-size: 22px');
  });

  it('.board-container имеет max-width для предотвращения overflow на 320px', () => {
    const mobileSection = css.slice(css.lastIndexOf('@media (max-width: 480px)'));
    // Specifically check for the max-width calc rule (not puzzle-page .board-container)
    expect(mobileSection).toContain('max-width: calc(100vw - 16px)');
  });

  it('.time-controls переключается на grid 2 колонки на мобильных', () => {
    const mobileSection = css.slice(css.lastIndexOf('@media (max-width: 480px)'));
    const idx = mobileSection.indexOf('.time-controls');
    const block = mobileSection.slice(idx, idx + 200);
    expect(block).toContain('grid-template-columns: repeat(2, 1fr)');
  });

  it('.rush-stats-grid на мобильных — 2 колонки', () => {
    const mobileSection = css.slice(css.lastIndexOf('@media (max-width: 480px)'));
    expect(mobileSection).toContain('.rush-stats-grid');
    const idx = mobileSection.indexOf('.rush-stats-grid');
    const block = mobileSection.slice(idx, idx + 100);
    expect(block).toContain('grid-template-columns: repeat(2, 1fr)');
  });

  it('.game-sidebar не имеет ограничения max-height на мобильных', () => {
    const mobileSection = css.slice(css.lastIndexOf('@media (max-width: 480px)'));
    expect(mobileSection).toContain('.game-sidebar');
    const idx = mobileSection.indexOf('.game-sidebar');
    const block = mobileSection.slice(idx, idx + 100);
    expect(block).toContain('max-height: none');
  });
});
