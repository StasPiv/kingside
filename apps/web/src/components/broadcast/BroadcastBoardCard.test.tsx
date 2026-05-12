import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BroadcastGameSummary } from '@kingside/shared';

import { renderWithProviders, screen } from '../../test/test-utils';
import { BroadcastBoardCard, computeLastMoveSan } from './BroadcastBoardCard';

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
  it('PGN c ходами → виден SAN последнего хода', () => {
    const game = makeGame({
      pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5',
      clockUpdatedAt: '2026-05-12T10:03:00.000Z', // 2 минуты назад
    });
    renderWithProviders(<BroadcastBoardCard game={game} />);
    expect(screen.getByTestId('broadcast-board-last-move-san')).toHaveTextContent(
      'Bb5',
    );
    // Время есть — clockUpdatedAt валиден.
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

  it('обновление PGN (новый ход) → SAN меняется', () => {
    const game = makeGame({
      pgn: '1. e4',
      clockUpdatedAt: '2026-05-12T10:04:00.000Z',
    });
    const { rerender } = renderWithProviders(<BroadcastBoardCard game={game} />);
    expect(screen.getByTestId('broadcast-board-last-move-san')).toHaveTextContent(
      'e4',
    );
    rerender(
      <BroadcastBoardCard
        game={{
          ...game,
          pgn: '1. e4 e5 2. Nf3',
          clockUpdatedAt: '2026-05-12T10:04:30.000Z',
        }}
      />,
    );
    expect(screen.getByTestId('broadcast-board-last-move-san')).toHaveTextContent(
      'Nf3',
    );
  });

  it('clockUpdatedAt=null → SAN есть, времени нет', () => {
    const game = makeGame({
      pgn: '1. e4 e5',
      clockUpdatedAt: null,
    });
    renderWithProviders(<BroadcastBoardCard game={game} />);
    expect(screen.getByTestId('broadcast-board-last-move-san')).toHaveTextContent(
      'e5',
    );
    expect(
      screen.queryByTestId('broadcast-board-last-move-time'),
    ).not.toBeInTheDocument();
  });
});

describe('computeLastMoveSan (KS-2795)', () => {
  it('возвращает SAN последнего хода', () => {
    expect(computeLastMoveSan('1. e4 e5 2. Nf3 Nc6')).toBe('Nc6');
    expect(computeLastMoveSan('1. e4')).toBe('e4');
  });

  it('возвращает null при пустом или битом PGN', () => {
    expect(computeLastMoveSan('')).toBeNull();
    expect(computeLastMoveSan('не-pgn')).toBeNull();
  });

  it('переживает PGN с %clk-комментариями (стрипит и грузит)', () => {
    const pgn = '1. e4 {[%clk 1:30:00]} e5 {[%clk 1:29:58]} 2. Nf3 {[%clk 1:29:55]}';
    expect(computeLastMoveSan(pgn)).toBe('Nf3');
  });
});
