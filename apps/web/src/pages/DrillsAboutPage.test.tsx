import { describe, it, expect } from 'vitest';
import type { CSSProperties } from 'react';
import { vi } from 'vitest';
import { renderWithProviders, screen } from '../test/test-utils';
import { DrillsAboutPage } from './DrillsAboutPage';

// Mock board — не вызываем реальный chess.js парсер.
vi.mock('../components/MemoChessboard', () => ({
  MemoChessboard: ({
    options,
  }: {
    options: { position?: string; squareStyles?: Record<string, CSSProperties> };
  }) => (
    <div
      data-testid="mock-board"
      data-position={options.position ?? ''}
    />
  ),
}));

/**
 * KS-2418 — страница `/drills/about`. Проверяем что:
 *  - все 7 drill-типов отрендерены как карточки;
 *  - для каждой карточки есть пример (mock board с FEN из i18n);
 *  - есть intro, tips и кнопка «back».
 */
describe('<DrillsAboutPage> KS-2418', () => {
  it('рендерит ровно 7 карточек drill-типов', () => {
    renderWithProviders(<DrillsAboutPage />);
    const cards = screen.getAllByTestId(/^drills-about-card-/);
    expect(cards).toHaveLength(7);
  });

  it('каждая карточка содержит read-only board с FEN из i18n', () => {
    renderWithProviders(<DrillsAboutPage />);
    const boards = screen.getAllByTestId('mock-board');
    expect(boards).toHaveLength(7);
    const fens = boards.map((b) => b.getAttribute('data-position'));
    // Проверяем несколько ключевых FEN'ов из контента KS-2417.
    expect(fens).toContain('8/8/8/5p2/4kP2/8/4K3/8 b - - 8 68');
    expect(fens).toContain('8/8/8/8/2p3K1/2P5/1k6/8 w - - 0 59');
    expect(fens).toContain('5k2/4n3/7P/p5p1/P2q4/6P1/2Q2P2/6K1 b - - 1 41');
  });

  it('заголовок и intro отрисованы', () => {
    renderWithProviders(<DrillsAboutPage />);
    expect(
      screen.getByText('How drills work', { selector: 'h1' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('drills-about-intro').textContent).toContain(
      'A drill is a short single-position exercise',
    );
  });

  it('блок tips содержит 4 совета', () => {
    renderWithProviders(<DrillsAboutPage />);
    const tipsBlock = screen.getByTestId('drills-about-tips');
    const items = tipsBlock.querySelectorAll('.drills-about__tip-item');
    expect(items.length).toBe(4);
  });

  it('кнопка back присутствует', () => {
    renderWithProviders(<DrillsAboutPage />);
    expect(screen.getByTestId('drills-about-back')).toBeInTheDocument();
  });
});
