import { describe, it, expect, vi } from 'vitest';
import type { CSSProperties } from 'react';
import { act } from '@testing-library/react';
import { renderWithProviders, screen } from '../../test/test-utils';
import { BlindBoardRunner } from './BlindBoardRunner';

/**
 * KS-3442 (ADR-088 §11 F1) — unit-тесты для blind-board runner.
 * MemoChessboard замокан как кнопочная сетка с fire-square — чтобы
 * симулировать клики; squareStyles/arrows прокидываются в data-*.
 */

vi.mock('../MemoChessboard', () => ({
  MemoChessboard: ({
    options,
  }: {
    options: {
      position?: string;
      allowDragging?: boolean;
      arrows?: Array<{ startSquare: string; endSquare: string; color: string }>;
      squareStyles?: Record<string, CSSProperties>;
      onSquareClick?: (a: { piece: unknown; square: string }) => void;
    };
  }) => {
    const SQUARES = ['a1', 'a2', 'b1', 'd4', 'e2', 'e4', 'g1', 'h8'];
    return (
      <div
        data-testid="mock-board"
        data-position={options.position}
        data-allow-dragging={String(options.allowDragging)}
        data-arrows={(options.arrows ?? []).length}
        data-arrow-from={options.arrows?.[0]?.startSquare ?? ''}
        data-arrow-to={options.arrows?.[0]?.endSquare ?? ''}
        data-highlight-keys={Object.keys(options.squareStyles ?? {}).join(',')}
      >
        {SQUARES.map((sq) => (
          <button
            key={sq}
            type="button"
            data-testid={`fire-square-${sq}`}
            onClick={() => options.onSquareClick?.({ piece: null, square: sq })}
          >
            {sq}
          </button>
        ))}
      </div>
    );
  },
}));

describe('<BlindBoardRunner>', () => {
  it('пустой FEN + drag off; подсветка from/to + одна стрелка', () => {
    renderWithProviders(
      <BlindBoardRunner
        move={{ from: 'e2', to: 'e4' }}
        onSubmit={() => {}}
      />,
    );
    const board = screen.getByTestId('mock-board');
    expect(board.getAttribute('data-position')).toBe(
      '8/8/8/8/8/8/8/8 w - - 0 1',
    );
    expect(board.getAttribute('data-allow-dragging')).toBe('false');
    expect(board.getAttribute('data-arrows')).toBe('1');
    expect(board.getAttribute('data-arrow-from')).toBe('e2');
    expect(board.getAttribute('data-arrow-to')).toBe('e4');
    // Подсветка двух клеток (порядок неважен).
    const keys = (board.getAttribute('data-highlight-keys') ?? '').split(',');
    expect(keys).toContain('e2');
    expect(keys).toContain('e4');
  });

  it('клик клетки → промоушн-модал → пик Q → onSubmit({square, pieceType})', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(
      <BlindBoardRunner
        move={{ from: 'a2', to: 'a4' }}
        onSubmit={onSubmit}
      />,
    );
    // Изначально модала нет.
    expect(screen.queryByTestId('blind-board-promotion')).toBeNull();
    await act(async () => {
      (screen.getByTestId('fire-square-d4') as HTMLButtonElement).click();
    });
    // Модал открылся для d4.
    expect(screen.getByTestId('blind-board-promotion')).toBeTruthy();
    expect(screen.getByTestId('blind-board-promotion-square').textContent).toBe(
      'd4',
    );
    // Тап ферзя.
    await act(async () => {
      (screen.getByTestId('blind-board-promotion-Q') as HTMLButtonElement).click();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ square: 'd4', pieceType: 'Q' });
    // Модал закрылся.
    expect(screen.queryByTestId('blind-board-promotion')).toBeNull();
  });

  it('disabled=true → клик клетки не открывает модал', () => {
    renderWithProviders(
      <BlindBoardRunner
        move={{ from: 'g1', to: 'f3' }}
        onSubmit={() => {}}
        disabled
      />,
    );
    (screen.getByTestId('fire-square-h8') as HTMLButtonElement).click();
    expect(screen.queryByTestId('blind-board-promotion')).toBeNull();
  });

  it('move=null (сессия завершена) → нет стрелок, клик ничего не делает', () => {
    const onSubmit = vi.fn();
    renderWithProviders(
      <BlindBoardRunner move={null} onSubmit={onSubmit} />,
    );
    expect(screen.getByTestId('mock-board').getAttribute('data-arrows')).toBe(
      '0',
    );
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    expect(screen.queryByTestId('blind-board-promotion')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('cancel в модале закрывает без onSubmit', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(
      <BlindBoardRunner
        move={{ from: 'a2', to: 'a4' }}
        onSubmit={onSubmit}
      />,
    );
    await act(async () => {
      (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    });
    expect(screen.getByTestId('blind-board-promotion')).toBeTruthy();
    await act(async () => {
      (screen.getByTestId('blind-board-promotion-cancel') as HTMLButtonElement).click();
    });
    expect(screen.queryByTestId('blind-board-promotion')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
