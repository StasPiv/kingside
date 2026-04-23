import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders, screen } from '../../test/test-utils';
import { BroadcastSwissStandings } from './BroadcastSwissStandings';
import type { CrosstableSwiss, CrosstablePlayer, CrosstableCell } from '@kingside/shared';

/**
 * KS-1738 / ADR-023 §2.11 (A14) — unit-тесты swiss-standings N×R.
 * Проверяют pairings-ячейки (op+color+result), bye, кликабельность.
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

function cell(
  result: CrosstableCell['result'],
  opRank?: number,
  color?: CrosstableCell['color'],
  gameId?: string,
): CrosstableCell {
  const ref = gameId
    ? { gameId, roundId: `r-${gameId}`, roundName: 'R' }
    : undefined;
  return {
    result,
    ...(opRank !== undefined ? { opponentRank: opRank } : {}),
    ...(color ? { color } : {}),
    ...(ref ? { gameRef: ref } : {}),
  };
}

const BASE = {
  sourceType: 'chess-results' as const,
  sourceUrl: 'https://chess-results.com/x',
  fetchedAt: '2026-04-23T10:00:00.000Z',
} satisfies Pick<CrosstableSwiss, 'sourceType' | 'sourceUrl' | 'fetchedAt'>;

describe('<BroadcastSwissStandings>', () => {
  it('рендерит 3 игрока × 3 тура с parings-ячейками', () => {
    const data: CrosstableSwiss = {
      ...BASE,
      tournamentType: 'swiss',
      roundCount: 3,
      players: [
        player({ rank: 1, name: 'Carlsen', elo: 2830, points: 2.5 }),
        player({ rank: 2, name: 'Nepo', elo: 2790, points: 2 }),
        player({ rank: 3, name: 'Ding', elo: 2780, points: 1.5 }),
      ],
      pairings: [
        [cell('win', 3, 'white', 'g1'), cell('draw', 2, 'black', 'g2'), cell('win', 2, 'white', 'g3')],
        [cell('loss', 3, 'white', 'g4'), cell('draw', 1, 'white', 'g2'), cell('loss', 1, 'black', 'g3')],
        [cell('loss', 1, 'black', 'g1'), cell('win', 2, 'black', 'g4'), cell('bye')],
      ],
    };

    renderWithProviders(<BroadcastSwissStandings data={data} broadcastId="b1" />);

    expect(screen.getByTestId('broadcast-swiss-standings')).toBeInTheDocument();
    expect(screen.getByText('Carlsen')).toBeInTheDocument();
    // Заголовки туров
    expect(screen.getByRole('columnheader', { name: '1' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '2' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '3' })).toBeInTheDocument();
    // Хотя бы один результат — в таблице присутствует «1», «0», «½», «—» (bye)
    expect(screen.getAllByText('1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
    expect(screen.getAllByText('½').length).toBeGreaterThan(0);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('клик по ячейке с gameRef вызывает navigate на /broadcasts/:id/:roundId/:gameId', () => {
    const data: CrosstableSwiss = {
      ...BASE,
      tournamentType: 'swiss',
      roundCount: 1,
      players: [
        player({ rank: 1, name: 'A' }),
        player({ rank: 2, name: 'B' }),
      ],
      pairings: [
        [cell('win', 2, 'white', 'gX')],
        [cell('loss', 1, 'black', 'gX')],
      ],
    };
    const { container } = renderWithProviders(<BroadcastSwissStandings data={data} broadcastId="B" />);
    const winCell = container.querySelector('.broadcast-xt-cell--win')!;
    expect(winCell).toHaveClass('broadcast-xt-cell--clickable');
    fireEvent.click(winCell);
    expect(mockNavigate).toHaveBeenCalledWith('/broadcasts/B/r-gX/gX');
  });

  it('bye рендерится как «—» и не кликабелен', () => {
    const data: CrosstableSwiss = {
      ...BASE,
      tournamentType: 'swiss',
      roundCount: 1,
      players: [player({ rank: 1, name: 'Solo' })],
      pairings: [[cell('bye')]],
    };
    renderWithProviders(<BroadcastSwissStandings data={data} broadcastId="B" />);
    const td = screen.getByText('—').closest('td')!;
    expect(td).toHaveClass('broadcast-xt-cell--bye');
    fireEvent.click(td);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('рендерит 20 игроков × 11 туров и sticky-класс на первой колонке', () => {
    const players: CrosstablePlayer[] = Array.from({ length: 20 }, (_, i) =>
      player({ rank: i + 1, name: `P${i + 1}`, elo: 2500 - i * 10, points: 11 - i * 0.5 }),
    );
    const pairings: CrosstableCell[][] = players.map((_, ri) =>
      Array.from({ length: 11 }, (_, r) => cell(r % 2 === 0 ? 'win' : 'loss', ((ri + r) % 20) + 1, r % 2 === 0 ? 'white' : 'black', `g${ri}-${r}`)),
    );

    const data: CrosstableSwiss = {
      ...BASE,
      tournamentType: 'swiss',
      roundCount: 11,
      players,
      pairings,
    };
    renderWithProviders(<BroadcastSwissStandings data={data} broadcastId="B" />);

    expect(screen.getByTestId('broadcast-swiss-standings')).toBeInTheDocument();
    // Sticky-класс присутствует на шапке и на первой колонке (#)
    const rankHeader = screen.getByRole('columnheader', { name: '#' });
    expect(rankHeader).toHaveClass('broadcast-xt-sticky');
  });

  it('возвращает empty-state при players=[]', () => {
    const data: CrosstableSwiss = {
      ...BASE,
      tournamentType: 'swiss',
      roundCount: 0,
      players: [],
      pairings: [],
    };
    renderWithProviders(<BroadcastSwissStandings data={data} broadcastId="b" />);
    expect(screen.getByTestId('broadcast-swiss-standings-empty')).toBeInTheDocument();
  });
});
