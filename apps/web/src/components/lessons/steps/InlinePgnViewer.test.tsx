import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../../test/test-utils';
import { InlinePgnViewer } from './InlinePgnViewer';

vi.mock('react-chessboard', () => ({
  Chessboard: (props: {
    options: {
      position?: string;
      squareStyles?: Record<string, React.CSSProperties>;
    };
  }) => (
    <div
      data-testid="chessboard"
      data-fen={props.options.position}
      data-square-styles={JSON.stringify(props.options.squareStyles ?? null)}
    />
  ),
}));

const SHORT_PGN = '1. e4 e5 2. Nf3 Nc6 3. Bb5 *';

const FROM_FEN_PGN =
  '[Event "Mate"]\n[FEN "7k/8/8/8/8/8/8/R6K w - - 0 1"]\n[SetUp "1"]\n\n1. Ra8# 1-0';

describe('<InlinePgnViewer>', () => {
  it('парсит PGN и стартует на ply=0 (стартовая позиция)', () => {
    renderWithProviders(<InlinePgnViewer pgn={SHORT_PGN} />);
    const root = screen.getByTestId('inline-pgn-viewer');
    expect(root.getAttribute('data-state')).toBe('ready');
    expect(root.getAttribute('data-ply')).toBe('0');
    // Counter «0/6» (3 хода каждой стороны = 6 plies).
    expect(screen.getByTestId('inline-pgn-viewer-counter').textContent).toBe(
      '0/5',
    );
  });

  it('кнопка next перемещает на следующий ply, last — в конец', () => {
    renderWithProviders(<InlinePgnViewer pgn={SHORT_PGN} />);
    fireEvent.click(screen.getByTestId('inline-pgn-viewer-next'));
    expect(
      screen.getByTestId('inline-pgn-viewer-counter').textContent,
    ).toBe('1/5');
    fireEvent.click(screen.getByTestId('inline-pgn-viewer-last'));
    expect(
      screen.getByTestId('inline-pgn-viewer-counter').textContent,
    ).toBe('5/5');
    // На последнем ply кнопки next/last выключены, prev/first — нет.
    expect(
      (screen.getByTestId('inline-pgn-viewer-next') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('inline-pgn-viewer-last') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('клик по ходу в списке прыгает на этот ply, помечает текущим', () => {
    renderWithProviders(<InlinePgnViewer pgn={SHORT_PGN} />);
    // 3-й ход (index 2) = Nf3.
    fireEvent.click(screen.getByTestId('inline-pgn-viewer-move-2'));
    expect(
      screen.getByTestId('inline-pgn-viewer-counter').textContent,
    ).toBe('3/5');
    expect(
      screen
        .getByTestId('inline-pgn-viewer-move-2')
        .getAttribute('data-current'),
    ).toBe('true');
    // другие ходы не current
    expect(
      screen
        .getByTestId('inline-pgn-viewer-move-0')
        .getAttribute('data-current'),
    ).toBe('false');
  });

  it('подсветка last-move: squareStyles на from/to после next', () => {
    renderWithProviders(<InlinePgnViewer pgn={SHORT_PGN} />);
    fireEvent.click(screen.getByTestId('inline-pgn-viewer-next'));
    const board = screen.getByTestId('chessboard');
    const styles = JSON.parse(board.getAttribute('data-square-styles') ?? 'null');
    // 1.e4 → from e2, to e4.
    expect(styles).toMatchObject({
      e2: { backgroundColor: expect.stringMatching(/rgba/) },
      e4: { backgroundColor: expect.stringMatching(/rgba/) },
    });
  });

  it('PGN с тегом [FEN ...] стартует с этой позиции', () => {
    renderWithProviders(<InlinePgnViewer pgn={FROM_FEN_PGN} />);
    const board = screen.getByTestId('chessboard');
    expect(board.getAttribute('data-fen')).toBe(
      '7k/8/8/8/8/8/8/R6K w - - 0 1',
    );
    // 1 ход → counter «0/1».
    expect(
      screen.getByTestId('inline-pgn-viewer-counter').textContent,
    ).toBe('0/1');
  });

  it('пустой/невалидный PGN → fallback "не удалось разобрать"', () => {
    renderWithProviders(<InlinePgnViewer pgn="" />);
    expect(
      screen.getByTestId('inline-pgn-viewer').getAttribute('data-state'),
    ).toBe('error');
  });

  it('клавиша → листает на следующий ход, ← на предыдущий', () => {
    renderWithProviders(<InlinePgnViewer pgn={SHORT_PGN} />);
    const root = screen.getByTestId('inline-pgn-viewer');
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(
      screen.getByTestId('inline-pgn-viewer-counter').textContent,
    ).toBe('1/5');
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(
      screen.getByTestId('inline-pgn-viewer-counter').textContent,
    ).toBe('2/5');
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    expect(
      screen.getByTestId('inline-pgn-viewer-counter').textContent,
    ).toBe('1/5');
  });
});
