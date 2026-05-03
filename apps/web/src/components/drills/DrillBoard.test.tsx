import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import userEvent from '@testing-library/user-event';
import type { CSSProperties } from 'react';
import { DrillBoard } from './DrillBoard';

vi.mock('../MemoChessboard', () => ({
  MemoChessboard: ({
    options,
  }: {
    options: {
      position?: string;
      boardOrientation?: 'white' | 'black';
      squareStyles?: Record<string, CSSProperties>;
      allowDragging?: boolean;
      onSquareClick?: (args: { piece: unknown; square: string }) => void;
    };
  }) => (
    <div
      data-testid="mock-board"
      data-position={options.position ?? ''}
      data-orientation={options.boardOrientation ?? 'white'}
      data-allow-dragging={options.allowDragging ? 'true' : 'false'}
      data-highlighted={
        options.squareStyles ? Object.keys(options.squareStyles).join(',') : ''
      }
    >
      <button
        type="button"
        data-testid="fire-square-click-e5"
        onClick={() => options.onSquareClick?.({ piece: null, square: 'e5' })}
      >
        click e5
      </button>
    </div>
  ),
}));

const FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

describe('<DrillBoard>', () => {
  it('рендерит контейнер с testid и проксирует position в Chessboard', () => {
    renderWithProviders(<DrillBoard position={FEN} />);
    expect(screen.getByTestId('drill-board')).toBeInTheDocument();
    expect(screen.getByTestId('mock-board').getAttribute('data-position')).toBe(
      FEN,
    );
  });

  it('по умолчанию orientation=white, drag запрещён', () => {
    renderWithProviders(<DrillBoard position={FEN} />);
    const board = screen.getByTestId('mock-board');
    expect(board.getAttribute('data-orientation')).toBe('white');
    expect(board.getAttribute('data-allow-dragging')).toBe('false');
  });

  it('boardOrientation="black" → передаётся в Chessboard', () => {
    renderWithProviders(
      <DrillBoard position={FEN} boardOrientation="black" />,
    );
    expect(screen.getByTestId('mock-board').getAttribute('data-orientation')).toBe(
      'black',
    );
  });

  it('highlightedSquares → squareStyles с этими ключами', () => {
    renderWithProviders(
      <DrillBoard position={FEN} highlightedSquares={['e4', 'e5']} />,
    );
    const board = screen.getByTestId('mock-board');
    expect(board.getAttribute('data-highlighted')).toBe('e4,e5');
  });

  it('пустой / undefined highlightedSquares → squareStyles НЕ задан', () => {
    renderWithProviders(<DrillBoard position={FEN} highlightedSquares={[]} />);
    expect(screen.getByTestId('mock-board').getAttribute('data-highlighted')).toBe(
      '',
    );
  });

  it('overlay рендерится в drill-board-overlay', () => {
    renderWithProviders(
      <DrillBoard position={FEN} overlay={<span>HINT</span>} />,
    );
    const overlay = screen.getByTestId('drill-board-overlay');
    expect(overlay).toBeInTheDocument();
    expect(overlay.textContent).toBe('HINT');
  });

  it('без overlay overlay-узел не рендерится', () => {
    renderWithProviders(<DrillBoard position={FEN} />);
    expect(screen.queryByTestId('drill-board-overlay')).not.toBeInTheDocument();
  });

  it('onSquareClick проксируется с square из chessboard', async () => {
    const onSquareClick = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DrillBoard position={FEN} onSquareClick={onSquareClick} />,
    );
    await user.click(screen.getByTestId('fire-square-click-e5'));
    expect(onSquareClick).toHaveBeenCalledTimes(1);
    expect(onSquareClick).toHaveBeenCalledWith('e5');
  });

  it('allowDragging=true передаётся в Chessboard', () => {
    renderWithProviders(<DrillBoard position={FEN} allowDragging />);
    expect(screen.getByTestId('mock-board').getAttribute('data-allow-dragging')).toBe(
      'true',
    );
  });
});
