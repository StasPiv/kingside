import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BroadcastGameSummary, BroadcastRoundItem } from '@kingside/shared';

import { renderWithProviders, screen, waitFor } from '../test/test-utils';

/**
 * KS-1823: регрессионный тест — страница раунда всегда показывает
 * `broadcast-boards-grid` с досками, независимо от `tournamentType`.
 * Ветка `tournamentType === 'playoff'` → `PlayoffBracket` на этой
 * странице была ошибкой и откачена; сетка переедет на Standings
 * в KS-1825.
 */

const broadcastApiMock = { get: vi.fn() };

vi.mock('../api/broadcastApi', () => ({
  broadcastApi: {
    get: (...a: unknown[]) => broadcastApiMock.get(...a),
  },
}));

vi.mock('react-chessboard', () => ({
  Chessboard: ({ options }: { options: { position?: string } }) => (
    <div data-testid="chessboard-mock" data-position={options.position ?? ''} />
  ),
}));

vi.mock('../hooks/useSounds', () => ({
  useSounds: () => ({ playSound: vi.fn() }),
  soundEventFromSan: () => 'move',
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useParams: () => ({ tournamentId: 'tx', roundId: 'r1' }),
  };
});

import { BroadcastRoundPage } from './BroadcastRoundPage';

beforeEach(() => {
  broadcastApiMock.get.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setupMocks(tournamentType: BroadcastRoundItem['tournamentType']) {
  const game: BroadcastGameSummary = {
    id: 'g1',
    lichessGameId: 'lg1',
    whitePlayer: 'Alice',
    blackPlayer: 'Bob',
    whiteElo: 2500,
    blackElo: 2500,
    result: '*',
    pgn: '1. e4',
    currentFen: null,
    updatedAt: '2026-04-24T10:00:00.000Z',
    bracketStage: null,
    bracketPairId: null,
    matchScore: null,
  };
  const round: BroadcastRoundItem = {
    id: 'r1',
    lichessRoundId: 'lr1',
    name: 'Round 1',
    startsAt: null,
    status: 'ongoing',
    tournamentType,
  };
  broadcastApiMock.get
    // broadcast meta
    .mockResolvedValueOnce({ id: 'tx', title: 'Demo Tournament' })
    // rounds
    .mockResolvedValueOnce({ data: [round] })
    // games
    .mockResolvedValueOnce({ data: [game] });
}

describe('BroadcastRoundPage (KS-1823 hotfix)', () => {
  it('tournamentType=playoff → рендерит broadcast-boards-grid (НЕ сетку)', async () => {
    setupMocks('playoff');
    const { container } = renderWithProviders(<BroadcastRoundPage />, {
      route: '/broadcasts/tx/r1',
    });
    await waitFor(() =>
      expect(container.querySelector('.broadcast-boards-grid')).toBeInTheDocument(),
    );
    // PlayoffBracket НЕ должен рендериться на странице раунда.
    expect(screen.queryByTestId('playoff-bracket')).not.toBeInTheDocument();
  });

  it('tournamentType=swiss → тот же broadcast-boards-grid (регрессии нет)', async () => {
    setupMocks('swiss');
    const { container } = renderWithProviders(<BroadcastRoundPage />, {
      route: '/broadcasts/tx/r1',
    });
    await waitFor(() =>
      expect(container.querySelector('.broadcast-boards-grid')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('playoff-bracket')).not.toBeInTheDocument();
  });

  it('tournamentType=null (классификатор ещё не сработал) → доски', async () => {
    setupMocks(null);
    const { container } = renderWithProviders(<BroadcastRoundPage />, {
      route: '/broadcasts/tx/r1',
    });
    await waitFor(() =>
      expect(container.querySelector('.broadcast-boards-grid')).toBeInTheDocument(),
    );
  });
});

/**
 * KS-2446: партии тура должны быть отсортированы по фамилии белых A→Z и
 * не «прыгать» при поступлении хода (даже если backend меняет порядок).
 */
describe('BroadcastRoundPage KS-2446 sort by white surname', () => {
  function makeGame(overrides: Partial<BroadcastGameSummary> & Pick<BroadcastGameSummary, 'id' | 'whitePlayer'>): BroadcastGameSummary {
    return {
      lichessGameId: `lg-${overrides.id}`,
      blackPlayer: 'Black, Player',
      whiteElo: null,
      blackElo: null,
      result: '*',
      pgn: '1. e4',
      currentFen: null,
      updatedAt: '2026-04-24T10:00:00.000Z',
      bracketStage: null,
      bracketPairId: null,
      matchScore: null,
      ...overrides,
    } as BroadcastGameSummary;
  }

  it('сортирует доски по whitePlayer A→Z; null whitePlayer — в конец', async () => {
    const round: BroadcastRoundItem = {
      id: 'r1',
      lichessRoundId: 'lr1',
      name: 'Round 6',
      startsAt: null,
      status: 'ongoing',
      tournamentType: 'swiss',
    };
    const games: BroadcastGameSummary[] = [
      makeGame({ id: 'g1', whitePlayer: 'Woodward, Andy' }),
      makeGame({ id: 'g2', whitePlayer: 'Zhu, Jiner' }),
      makeGame({ id: 'g3', whitePlayer: 'Van Foreest, Jorden' }),
      makeGame({ id: 'g4', whitePlayer: 'Erdogmus, Yagiz Kaan' }),
      makeGame({ id: 'g5', whitePlayer: null }),
    ];
    broadcastApiMock.get
      .mockResolvedValueOnce({ id: 'tx', title: 'TePe Sigeman' })
      .mockResolvedValueOnce({ data: [round] })
      .mockResolvedValueOnce({ data: games });

    const { container } = renderWithProviders(<BroadcastRoundPage />, {
      route: '/broadcasts/tx/r1',
    });
    await waitFor(() =>
      expect(container.querySelector('.broadcast-boards-grid')).toBeInTheDocument(),
    );
    const cards = Array.from(
      container.querySelectorAll('.broadcast-boards-grid .broadcast-board-card'),
    );
    const ids = cards.map((c) =>
      (c.getAttribute('data-testid') ?? '').replace(/^broadcast-board-card-/, ''),
    );
    // Ожидаем порядок по фамилии белых, null — в конец.
    expect(ids).toEqual(['g4', 'g3', 'g1', 'g2', 'g5']);
  });
});
