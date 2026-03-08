import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * KS-263: Реверификация фикса KS-254 — мобильная вёрстка Puzzle Rush
 *
 * Статический анализ CSS: проверяем наличие необходимых правил
 * для корректного отображения на viewport 375px.
 */
describe('KS-254: мобильная вёрстка CSS', () => {
  const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf-8');

  it('media query @media (max-width: 480px) существует', () => {
    expect(css).toContain('@media (max-width: 480px)');
  });

  it('.main имеет overflow-x: hidden для предотвращения горизонтального скролла', () => {
    // Ищем правило внутри media query
    const mobileSection = css.slice(css.indexOf('@media (max-width: 480px)'));
    expect(mobileSection).toContain('overflow-x: hidden');
  });

  it('навигация имеет flex-wrap для корректного переноса', () => {
    const mobileSection = css.slice(css.indexOf('@media (max-width: 480px)'));
    expect(mobileSection).toContain('flex-wrap: wrap');
  });

  it('.puzzle-rush-header имеет уменьшенный gap для мобильных', () => {
    const mobileSection = css.slice(css.indexOf('@media (max-width: 480px)'));
    expect(mobileSection).toContain('.puzzle-rush-header');
    // gap должен быть меньше десктопного (32px → 16px)
    const headerIdx = mobileSection.indexOf('.puzzle-rush-header');
    const headerBlock = mobileSection.slice(headerIdx, headerIdx + 100);
    expect(headerBlock).toContain('gap: 16px');
  });

  it('.rush-time имеет уменьшенный шрифт для мобильных', () => {
    const mobileSection = css.slice(css.indexOf('@media (max-width: 480px)'));
    expect(mobileSection).toContain('.rush-time');
    const timeIdx = mobileSection.indexOf('.rush-time');
    const timeBlock = mobileSection.slice(timeIdx, timeIdx + 100);
    expect(timeBlock).toContain('font-size: 24px');
  });

  it('.puzzle-rush-page имеет уменьшенный padding для мобильных', () => {
    const mobileSection = css.slice(css.indexOf('@media (max-width: 480px)'));
    // Ищем именно .puzzle-rush-page { (без продолжения селектора)
    const regex = /\.puzzle-rush-page\s*\{[^}]*padding-top:\s*16px/;
    expect(mobileSection).toMatch(regex);
  });

  it('.puzzle-rush-page .board-container адаптивная ширина', () => {
    const mobileSection = css.slice(css.indexOf('@media (max-width: 480px)'));
    expect(mobileSection).toContain('.puzzle-rush-page .board-container');
  });
});
