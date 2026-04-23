import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders, screen } from '../../test/test-utils';
import { RoundRobinCrosstable } from './RoundRobinCrosstable';
import type { CrosstableRoundRobin, CrosstablePlayer, CrosstableCell } from '@kingside/shared';

/**
 * KS-1737 / ADR-023 §2.11 (A13) — unit-тесты матрицы N×N round-robin.
 * Проверяют рендер шапки, заполнение матрицы, кликабельность через
 * mock `useNavigate`, обработку bye и ненабранной партии.
 */

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

beforeEach(() => {
  mockNavigate.mockReset();
});

function player(overrides: Partial<CrosstablePlayer> & Pick<CrosstablePlayer, 'rank' | 'name'>): CrosstablePlayer {
  return {
    normalizedName: overrides.name.toLowerCase(),
    points: 0,
    gamesPlayed: 0,
    ...overrides,
  };
}

function win(gameId?: string): CrosstableCell {
  return gameId
    ? { result: 'win', color: 'white', opponentRank: 0, gameRef: { gameId, roundId: `r-${gameId}`, roundName: 'R1' } }
    : { result: 'win', color: 'white' };
}

function loss(gameId?: string): CrosstableCell {
  return gameId
    ? { result: 'loss', color: 'black', gameRef: { gameId, roundId: `r-${gameId}`, roundName: 'R1' } }
    : { result: 'loss', color: 'black' };
}

function draw(gameId?: string): CrosstableCell {
  return gameId
    ? { result: 'draw', gameRef: { gameId, roundId: `r-${gameId}`, roundName: 'R1' } }
    : { result: 'draw' };
}

const BASE = {
  sourceType: 'chess-results' as const,
  sourceUrl: 'https://chess-results.com/tnr1',
  fetchedAt: '2026-04-23T10:00:00.000Z',
} satisfies Pick<CrosstableRoundRobin, 'sourceType' | 'sourceUrl' | 'fetchedAt'>;

describe('<RoundRobinCrosstable>', () => {
  it('рендерит 2×2 матрицу с диагональю ✕', () => {
    const data: CrosstableRoundRobin = {
      ...BASE,
      tournamentType: 'round-robin',
      players: [
        player({ rank: 1, name: 'Alice', points: 1, gamesPlayed: 1 }),
        player({ rank: 2, name: 'Bob', points: 0, gamesPlayed: 1 }),
      ],
      matrix: [
        [{ result: null }, win('g1')],
        [loss('g1'), { result: null }],
      ],
    };

    const { container } = renderWithProviders(<RoundRobinCrosstable data={data} broadcastId="b1" />);

    expect(screen.getByTestId('round-robin-crosstable')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    // Диагональные ячейки
    expect(screen.getAllByText('✕').length).toBe(2);
    // Результаты: по CSS-классу выигранной/проигранной ячейки
    expect(container.querySelector('.broadcast-xt-cell--win')).toHaveTextContent('1');
    expect(container.querySelector('.broadcast-xt-cell--loss')).toHaveTextContent('0');
  });

  it('на клик по ячейке с gameRef вызывает navigate с правильным путём', () => {
    const data: CrosstableRoundRobin = {
      ...BASE,
      tournamentType: 'round-robin',
      players: [
        player({ rank: 1, name: 'Alice' }),
        player({ rank: 2, name: 'Bob' }),
      ],
      matrix: [
        [{ result: null }, win('game-xyz')],
        [loss('game-xyz'), { result: null }],
      ],
    };

    const { container } = renderWithProviders(<RoundRobinCrosstable data={data} broadcastId="b42" />);

    const clickable = container.querySelector('.broadcast-xt-cell--win')!;
    expect(clickable).toHaveClass('broadcast-xt-cell--clickable');
    fireEvent.click(clickable);
    expect(mockNavigate).toHaveBeenCalledWith('/broadcasts/b42/r-game-xyz/game-xyz');
  });

  it('ячейка без gameRef не получает класс --clickable и не вызывает navigate', () => {
    const data: CrosstableRoundRobin = {
      ...BASE,
      tournamentType: 'round-robin',
      players: [
        player({ rank: 1, name: 'Alice' }),
        player({ rank: 2, name: 'Bob' }),
      ],
      matrix: [
        [{ result: null }, draw()],
        [draw(), { result: null }],
      ],
    };

    renderWithProviders(<RoundRobinCrosstable data={data} broadcastId="b1" />);

    const drawCells = screen.getAllByText('½');
    for (const el of drawCells) {
      const td = el.closest('td')!;
      expect(td).not.toHaveClass('broadcast-xt-cell--clickable');
    }
    fireEvent.click(drawCells[0].closest('td')!);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('bye рендерится символом * (из chess-results)', () => {
    const data: CrosstableRoundRobin = {
      ...BASE,
      tournamentType: 'round-robin',
      players: [
        player({ rank: 1, name: 'A' }),
        player({ rank: 2, name: 'B' }),
      ],
      matrix: [
        [{ result: null }, { result: 'bye' }],
        [{ result: null }, { result: null }],
      ],
    };
    renderWithProviders(<RoundRobinCrosstable data={data} broadcastId="b" />);
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  it('рендерит 8 игроков с tiebreak-ами и title-ами', () => {
    const players: CrosstablePlayer[] = Array.from({ length: 8 }, (_, i) =>
      player({
        rank: i + 1,
        name: `P${i + 1}`,
        federation: 'FID',
        elo: 2500 + i,
        title: i === 0 ? 'GM' : undefined,
        points: 7 - i,
        gamesPlayed: 7,
        tiebreaks: { sonnebornBerger: i + 1 },
      }),
    );
    const matrix: CrosstableCell[][] = Array.from({ length: 8 }, (_, ri) =>
      Array.from({ length: 8 }, (_, ci) => {
        if (ri === ci) return { result: null };
        if (ri < ci) return win(`g-${ri}-${ci}`);
        return loss(`g-${ci}-${ri}`);
      }),
    );
    const data: CrosstableRoundRobin = { ...BASE, tournamentType: 'round-robin', players, matrix };

    renderWithProviders(<RoundRobinCrosstable data={data} broadcastId="x" />);

    expect(screen.getByTestId('round-robin-crosstable')).toBeInTheDocument();
    expect(screen.getByText('GM')).toBeInTheDocument();
    // 8 игроков → 8 диагональных ✕
    expect(screen.getAllByText('✕').length).toBe(8);
    // tiebreak-колонка «SB»
    expect(screen.getByText('SB')).toBeInTheDocument();
  });

  it('возвращает empty-state при пустом players[]', () => {
    const data: CrosstableRoundRobin = {
      ...BASE,
      tournamentType: 'round-robin',
      players: [],
      matrix: [],
    };
    renderWithProviders(<RoundRobinCrosstable data={data} broadcastId="b" />);
    expect(screen.getByTestId('round-robin-crosstable-empty')).toBeInTheDocument();
  });
});
