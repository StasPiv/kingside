import { describe, it, expect, vi } from 'vitest';
import { Chess } from 'chess.js';

import { renderWithProviders, screen } from '../test/test-utils';
import { PuzzleBoard } from './PuzzleBoard';

/**
 * KS-3379. Тесты индикатора «чьего хода» в правом верхнем углу доски.
 * Покрытие:
 *  - turn='w' → класс `puzzle-turn-indicator--white`, текст «White to move».
 *  - turn='b' → класс `puzzle-turn-indicator--black`, текст «Black to move».
 *  - turn='b' при orientation='white' (доска не отзеркалена, но ход чёрных):
 *    индикатор всё равно чёрный (баг до KS-3379 был обратный).
 *  - game=null → fallback на boardOrientation (loading-state, доска
 *    ещё не смонтирована).
 */

// react-chessboard в jsdom — заменяем на пустой div.
vi.mock('react-chessboard', () => ({
  Chessboard: () => <div data-testid="chessboard-mock" />,
}));

const FEN_WHITE_TO_MOVE =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FEN_BLACK_TO_MOVE =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1';

const noop = () => true;

describe('<PuzzleBoard> KS-3379 — turn indicator', () => {
  it('turn=w + orientation=white → indicator white', () => {
    const game = new Chess(FEN_WHITE_TO_MOVE);
    renderWithProviders(
      <PuzzleBoard
        game={game}
        boardOrientation="white"
        enabled={false}
        onPieceDrop={noop}
      />,
    );
    const ind = screen.getByTestId('puzzle-turn-indicator');
    expect(ind.getAttribute('data-turn')).toBe('white');
    expect(ind.className).toContain('puzzle-turn-indicator--white');
    expect(ind.textContent).toMatch(/White to move|Ход белых/);
  });

  it('turn=b + orientation=black → indicator black', () => {
    const game = new Chess(FEN_BLACK_TO_MOVE);
    renderWithProviders(
      <PuzzleBoard
        game={game}
        boardOrientation="black"
        enabled={false}
        onPieceDrop={noop}
      />,
    );
    const ind = screen.getByTestId('puzzle-turn-indicator');
    expect(ind.getAttribute('data-turn')).toBe('black');
    expect(ind.className).toContain('puzzle-turn-indicator--black');
    expect(ind.textContent).toMatch(/Black to move|Ход чёрных/);
  });

  it('KS-3379: turn=b + orientation=white → indicator BLACK (не путаем с ориентацией)', () => {
    // Раньше: цвет был привязан к orientation → показывал white (баг).
    // Теперь: chess.turn() === 'b' → black, независимо от того что
    // доска не перевёрнута.
    const game = new Chess(FEN_BLACK_TO_MOVE);
    renderWithProviders(
      <PuzzleBoard
        game={game}
        boardOrientation="white"
        enabled={false}
        onPieceDrop={noop}
      />,
    );
    const ind = screen.getByTestId('puzzle-turn-indicator');
    expect(ind.getAttribute('data-turn')).toBe('black');
    expect(ind.className).toContain('puzzle-turn-indicator--black');
  });

  it('KS-3379: turn=w + orientation=black → indicator WHITE', () => {
    const game = new Chess(FEN_WHITE_TO_MOVE);
    renderWithProviders(
      <PuzzleBoard
        game={game}
        boardOrientation="black"
        enabled={false}
        onPieceDrop={noop}
      />,
    );
    const ind = screen.getByTestId('puzzle-turn-indicator');
    expect(ind.getAttribute('data-turn')).toBe('white');
    expect(ind.className).toContain('puzzle-turn-indicator--white');
  });

  it('game=null → fallback на boardOrientation (loading-state)', () => {
    renderWithProviders(
      <PuzzleBoard
        game={null}
        boardOrientation="black"
        enabled={false}
        onPieceDrop={noop}
      />,
    );
    const ind = screen.getByTestId('puzzle-turn-indicator');
    expect(ind.getAttribute('data-turn')).toBe('black');
  });
});
