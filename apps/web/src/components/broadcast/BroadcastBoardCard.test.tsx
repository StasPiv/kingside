import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BroadcastGameSummary } from '@kingside/shared';

import { renderWithProviders, screen } from '../../test/test-utils';
import { BroadcastBoardCard, computeLastMoveLabel } from './BroadcastBoardCard';

/**
 * KS-2795: блок «последний ход + время» под мини-доской.
 * Проверяем три сценария:
 *  1. PGN с ходами → SAN последнего хода виден в карточке.
 *  2. PGN пустой → плейсхолдер «Game not started».
 *  3. PGN обновился (re-render с новым `game.pgn`) → SAN меняется.
 */

vi.mock('react-chessboard', () => ({
  Chessboard: ({ options }: { options: { position?: string } }) => (
    <div data-testid="chessboard-mock" data-position={options.position ?? ''} />
  ),
}));

// BroadcastEvalBar тянет shared Stockfish worker — в тестах подменяем.
vi.mock('./BroadcastEvalBar', () => ({
  BroadcastEvalBar: () => <div data-testid="eval-bar-mock" />,
}));

function makeGame(over: Partial<BroadcastGameSummary>): BroadcastGameSummary {
  return {
    id: 'g1',
    lichessGameId: 'lg1',
    whitePlayer: 'Alice',
    blackPlayer: 'Bob',
    whiteElo: 2500,
    blackElo: 2500,
    result: '*',
    pgn: '',
    currentFen: null,
    updatedAt: '2026-05-12T10:00:00.000Z',
    bracketStage: null,
    bracketPairId: null,
    matchScore: null,
    clockUpdatedAt: null,
    lastMoveAt: null,
    whiteClockMs: null,
    blackClockMs: null,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Фиксируем «now» для предсказуемого relative-time.
  vi.setSystemTime(new Date('2026-05-12T10:05:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BroadcastBoardCard — last move block (KS-2795)', () => {
  it('PGN c ходами → виден SAN последнего хода с номером полного хода (KS-2836)', () => {
    const game = makeGame({
      pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5',
      lastMoveAt: '2026-05-12T10:03:00.000Z', // 2 минуты назад
    });
    renderWithProviders(<BroadcastBoardCard game={game} />);
    // KS-2836: ход белых на полуходе 5 → `3. Bb5`.
    expect(screen.getByTestId('broadcast-board-last-move-san')).toHaveTextContent(
      '3. Bb5',
    );
    // Время есть — lastMoveAt валиден.
    expect(screen.getByTestId('broadcast-board-last-move-time')).toBeInTheDocument();
  });

  it('PGN пустой → плейсхолдер «Game not started»', () => {
    const game = makeGame({ pgn: '' });
    renderWithProviders(<BroadcastBoardCard game={game} />);
    expect(
      screen.getByTestId('broadcast-board-last-move-placeholder'),
    ).toHaveTextContent(/game not started/i);
    expect(
      screen.queryByTestId('broadcast-board-last-move-san'),
    ).not.toBeInTheDocument();
    // Времени нет, когда нет SAN.
    expect(
      screen.queryByTestId('broadcast-board-last-move-time'),
    ).not.toBeInTheDocument();
  });

  it('обновление PGN (новый ход) → префикс+SAN меняется', () => {
    const game = makeGame({
      pgn: '1. e4',
      lastMoveAt: '2026-05-12T10:04:00.000Z',
    });
    const { rerender } = renderWithProviders(<BroadcastBoardCard game={game} />);
    // KS-2836: ход белых на полуходе 1 → `1. e4`.
    expect(screen.getByTestId('broadcast-board-last-move-san')).toHaveTextContent(
      '1. e4',
    );
    rerender(
      <BroadcastBoardCard
        game={{
          ...game,
          pgn: '1. e4 e5 2. Nf3',
          lastMoveAt: '2026-05-12T10:04:30.000Z',
        }}
      />,
    );
    // KS-2836: ход белых на полуходе 3 → `2. Nf3`.
    expect(screen.getByTestId('broadcast-board-last-move-san')).toHaveTextContent(
      '2. Nf3',
    );
  });

  it('lastMoveAt=null → SAN c префиксом есть, времени нет (KS-2836)', () => {
    const game = makeGame({
      pgn: '1. e4 e5',
      lastMoveAt: null,
    });
    renderWithProviders(<BroadcastBoardCard game={game} />);
    // Ход чёрных, полуход 2 → `1... e5`.
    expect(screen.getByTestId('broadcast-board-last-move-san')).toHaveTextContent(
      '1... e5',
    );
    expect(
      screen.queryByTestId('broadcast-board-last-move-time'),
    ).not.toBeInTheDocument();
  });
});

describe('computeLastMoveLabel (KS-2795 / KS-2836)', () => {
  it('PGN с одним ходом белых → { number: 1, side: w, san: e4 }', () => {
    expect(computeLastMoveLabel('1. e4')).toEqual({
      number: 1,
      side: 'w',
      san: 'e4',
    });
  });

  it('PGN `e4 e5` → { number: 1, side: b, san: e5 }', () => {
    expect(computeLastMoveLabel('1. e4 e5')).toEqual({
      number: 1,
      side: 'b',
      san: 'e5',
    });
  });

  it('PGN `e4 e5 Nf3` → { number: 2, side: w, san: Nf3 }', () => {
    expect(computeLastMoveLabel('1. e4 e5 2. Nf3')).toEqual({
      number: 2,
      side: 'w',
      san: 'Nf3',
    });
  });

  it('PGN c %clk-комментариями — стрипает и грузит', () => {
    const pgn = '1. e4 {[%clk 1:30:00]} e5 {[%clk 1:29:58]} 2. Nf3 {[%clk 1:29:55]}';
    expect(computeLastMoveLabel(pgn)).toEqual({
      number: 2,
      side: 'w',
      san: 'Nf3',
    });
  });

  it('PGN с FEN-header (mid-game): fullmove из FEN, ход чёрных → N...', () => {
    // Mid-game позиция, side-to-move=b, fullmove=22. После хода чёрных
    // fullmove инкрементируется до 23; computeLastMoveLabel должен вернуть
    // 22 (это и есть номер «полного хода 22», в котором ходили чёрные).
    const pgn =
      '[SetUp "1"]\n[FEN "r1bqkb1r/pp3ppp/2n2n2/2pp4/3P4/2N1PN2/PP3PPP/R1BQKB1R b KQkq - 0 22"]\n\n22... a6';
    expect(computeLastMoveLabel(pgn)).toEqual({
      number: 22,
      side: 'b',
      san: 'a6',
    });
  });

  it('PGN с FEN-header (mid-game): fullmove из FEN, ход белых → N.', () => {
    const pgn =
      '[SetUp "1"]\n[FEN "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 0 8"]\n\n8. O-O';
    expect(computeLastMoveLabel(pgn)).toEqual({
      number: 8,
      side: 'w',
      san: 'O-O',
    });
  });

  it('возвращает null при пустом или битом PGN', () => {
    expect(computeLastMoveLabel('')).toBeNull();
    expect(computeLastMoveLabel('не-pgn')).toBeNull();
  });
});
