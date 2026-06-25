import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * KS-4314: было — конкатенация всех `styles/*.css` и поиск
 * `lastIndexOf('@media (max-width: 480px)')`. Сломалось, как только
 * рядом появился `updateBanner.css` (сортируется после `responsive.css`)
 * с собственным `@media (max-width: 480px)` — `lastIndexOf` указывал
 * на блок банера, в котором тестируемых правил нет. Все ассерты
 * становились ложно-отрицательными.
 *
 * Все правила, которые проверяют тесты KS-254 / KS-388, живут в
 * `responsive.css` (mobile-overrides проекта). Читаем его напрямую и
 * вырезаем именно `@media (max-width: 480px)` блок по разметке
 * `}` верхнего уровня — без зависимости от порядка других файлов.
 */
function loadResponsiveMobileBlock(): string {
  const file = resolve(__dirname, 'styles/responsive.css');
  const css = readFileSync(file, 'utf-8');
  const start = css.indexOf('@media (max-width: 480px)');
  if (start === -1) throw new Error('responsive.css: @media (max-width: 480px) block not found');
  // Найти закрывающую `}` верхнего уровня — баланс фигурных скобок.
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error('responsive.css: unterminated @media block');
}

/**
 * KS-263: Реверификация фикса KS-254 — мобильная вёрстка Puzzle Rush
 *
 * Статический анализ CSS: проверяем наличие необходимых правил
 * для корректного отображения на viewport 375px.
 */
describe('KS-254: мобильная вёрстка CSS', () => {
  const mobileSection = loadResponsiveMobileBlock();

  it('media query @media (max-width: 480px) существует', () => {
    expect(mobileSection.startsWith('@media (max-width: 480px)')).toBe(true);
  });

  it('.main имеет overflow-x: hidden для предотвращения горизонтального скролла', () => {
    expect(mobileSection).toContain('overflow-x: hidden');
  });

  it('навигация имеет flex-wrap для корректного переноса', () => {
    expect(mobileSection).toContain('flex-wrap: wrap');
  });

  it('.puzzle-rush-header имеет уменьшенный gap для мобильных', () => {
    expect(mobileSection).toContain('.puzzle-rush-header');
    const headerIdx = mobileSection.indexOf('.puzzle-rush-header');
    const headerBlock = mobileSection.slice(headerIdx, headerIdx + 100);
    expect(headerBlock).toContain('gap: 16px');
  });

  it('.rush-time имеет уменьшенный шрифт для мобильных', () => {
    expect(mobileSection).toContain('.rush-time');
    const timeIdx = mobileSection.indexOf('.rush-time');
    const timeBlock = mobileSection.slice(timeIdx, timeIdx + 100);
    expect(timeBlock).toContain('font-size: 24px');
  });

  it('.puzzle-rush-page имеет уменьшенный padding для мобильных', () => {
    const regex = /\.puzzle-rush-page\s*\{[^}]*padding-top:\s*16px/;
    expect(mobileSection).toMatch(regex);
  });

  it('.puzzle-rush-page .board-container адаптивная ширина', () => {
    expect(mobileSection).toContain('.puzzle-rush-page .board-container');
  });
});

/**
 * KS-388: Адаптивная вёрстка для мобильных устройств
 */
describe('KS-388: мобильная вёрстка страниц', () => {
  const mobileSection = loadResponsiveMobileBlock();

  it('game-actions button имеет min-height 44px на мобильных', () => {
    expect(mobileSection).toContain('.game-actions button');
    expect(mobileSection).toContain('min-height: 44px');
  });

  it('.game-clock-bar имеет font-size >= 20px на мобильных', () => {
    // KS-4621: часы вынесены из `.player-info` в `.game-clock-bar`
    // (см. game.css / responsive.css). Ищем сам селектор (не упоминания
    // в комментариях) — он начинается с `.game-clock-bar` и за ним
    // открывается фигурная скобка.
    const m = mobileSection.match(/\.game-clock-bar\s*\{[^}]*\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/font-size:\s*\d+px/);
    const sizeMatch = m![0].match(/font-size:\s*(\d+)px/);
    expect(sizeMatch).not.toBeNull();
    expect(parseInt(sizeMatch![1], 10)).toBeGreaterThanOrEqual(20);
  });

  // KS-4301 / KS-4314: правила `.board-container { max-width: calc(100vw -
  // 16px) }` и `.game-sidebar { max-height: none }` удалены из
  // `responsive.css` — на mobile партии доска теперь edge-to-edge
  // (`game.css` mobile-блок), а `.game-sidebar` целиком `display: none`.
  // Старые тесты искали legacy-строки и стали ложно-отрицательными;
  // ассерт на наличие удалённых правил снят. Если потребуется новое
  // поведение, проще писать DOM-тест (см. `/tmp/KS-4301/probe.js`),
  // а не лезть в CSS-строки.

  it('.time-controls переключается на grid 2 колонки на мобильных', () => {
    const idx = mobileSection.indexOf('.time-controls');
    const block = mobileSection.slice(idx, idx + 200);
    expect(block).toContain('grid-template-columns: repeat(2, 1fr)');
  });

  it('.rush-stats-grid на мобильных — 2 колонки', () => {
    expect(mobileSection).toContain('.rush-stats-grid');
    const idx = mobileSection.indexOf('.rush-stats-grid');
    const block = mobileSection.slice(idx, idx + 100);
    expect(block).toContain('grid-template-columns: repeat(2, 1fr)');
  });
});
