/**
 * KS-2563: тесты `PuzzleMiniBoard` — статическая SVG-доска из FEN.
 * Заменила `<Chessboard>` на `/puzzles` гриде ради производительности
 * при 30+ карточках. Покрываем парсинг FEN, ориентацию, мемоизацию.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  PuzzleMiniBoard,
  fenToSquares,
} from './PuzzleMiniBoard';

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('fenToSquares KS-2563', () => {
  it('стартовая позиция → 64 ячейки', () => {
    const cells = fenToSquares(STARTING_FEN);
    expect(cells).toHaveLength(64);
  });

  it('пустые клетки правильно интерпретируются', () => {
    const cells = fenToSquares(STARTING_FEN);
    // Ряд 4 (rank=3) пустой.
    const rank3 = cells.filter((c) => c.rank === 3);
    expect(rank3).toHaveLength(8);
    expect(rank3.every((c) => c.piece === null)).toBe(true);
  });

  it('фигуры белых снизу (rank 0..1) — большие буквы; чёрных (rank 6..7) — маленькие', () => {
    const cells = fenToSquares(STARTING_FEN);
    const r0 = cells.filter((c) => c.rank === 0);
    expect(r0.every((c) => c.piece && c.piece === c.piece.toUpperCase())).toBe(
      true,
    );
    const r7 = cells.filter((c) => c.rank === 7);
    expect(r7.every((c) => c.piece && c.piece === c.piece.toLowerCase())).toBe(
      true,
    );
  });

  it('FEN с empty-числами в начале (например, 8/...)', () => {
    const cells = fenToSquares('8/8/8/8/4K3/8/8/4k3 w - - 0 1');
    // Король белых на e4 (file=4, rank=3); чёрных на e1 (file=4, rank=0).
    const wK = cells.find((c) => c.piece === 'K');
    expect(wK).toEqual({ file: 4, rank: 3, piece: 'K' });
    const bK = cells.find((c) => c.piece === 'k');
    expect(bK).toEqual({ file: 4, rank: 0, piece: 'k' });
  });

  it('невалидный FEN не падает (грейсфол)', () => {
    expect(() => fenToSquares('garbage')).not.toThrow();
    const cells = fenToSquares('garbage');
    expect(cells).toHaveLength(64);
  });
});

describe('<PuzzleMiniBoard> KS-2563', () => {
  it('рендерит 64 квадрата + 32 фигуры на стартовой позиции', () => {
    const { container } = render(<PuzzleMiniBoard fen={STARTING_FEN} />);
    const svg = container.querySelector('[data-testid="puzzle-mini-board"]');
    expect(svg).toBeInTheDocument();
    const rects = svg!.querySelectorAll('rect');
    expect(rects.length).toBe(64);
    const texts = svg!.querySelectorAll('text');
    expect(texts.length).toBe(32); // 16 white + 16 black
  });

  it('orientation=black меняет атрибут data-orientation', () => {
    const { container } = render(
      <PuzzleMiniBoard fen={STARTING_FEN} orientation="black" />,
    );
    const svg = container.querySelector('[data-testid="puzzle-mini-board"]');
    expect(svg!.getAttribute('data-orientation')).toBe('black');
  });

  it('orientation=white по умолчанию', () => {
    const { container } = render(<PuzzleMiniBoard fen={STARTING_FEN} />);
    expect(
      container
        .querySelector('[data-testid="puzzle-mini-board"]')!
        .getAttribute('data-orientation'),
    ).toBe('white');
  });
});
