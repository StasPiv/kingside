import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import { BlindBoardLevelUpOverlay } from './BlindBoardLevelUpOverlay';

vi.mock('../MemoChessboard', () => ({
  MemoChessboard: ({
    options,
  }: {
    options: { position?: string };
  }) => (
    <div data-testid="mock-board" data-position={options.position ?? ''} />
  ),
}));

describe('<BlindBoardLevelUpOverlay> KS-3489', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('KS-3522: рендерит FEN из levelUp.boardPosition (snapshot с сервера)', () => {
    renderWithProviders(
      <BlindBoardLevelUpOverlay
        boardPosition={[
          { square: 'a1', type: 'R' },
          { square: 'e4', type: 'N' },
        ]}
        newLevel={2}
        newPiece="B"
        newSquare="e4"
        memorizeTimeSec={5}
        onClose={() => {}}
      />,
    );
    expect(
      screen.getByTestId('blind-board-level-up').getAttribute('data-new-level'),
    ).toBe('2');
    expect(screen.getByTestId('blind-board-level-up-sub').textContent).toContain(
      'e4',
    );
    expect(
      screen.getByTestId('blind-board-level-up-board').getAttribute('data-fen'),
    ).toContain('R7');
    expect(
      screen
        .getByTestId('blind-board-level-up-board')
        .getAttribute('data-highlight-square'),
    ).toBe('e4');
  });

  it('кнопка Ready закрывает', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <BlindBoardLevelUpOverlay
        boardPosition={[{ square: 'a1', type: 'R' }]}
        newLevel={2}
        newPiece="B"
        newSquare="e4"
        memorizeTimeSec={5}
        onClose={onClose}
      />,
    );
    (
      screen.getByTestId('blind-board-level-up-ready') as HTMLButtonElement
    ).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('autoClose по memorizeTimeSec', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <BlindBoardLevelUpOverlay
        boardPosition={[{ square: 'a1', type: 'R' }]}
        newLevel={2}
        newPiece="B"
        newSquare="e4"
        memorizeTimeSec={3}
        onClose={onClose}
      />,
    );
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
