import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { BroadcastCrosstable } from './BroadcastCrosstable';
import type {
  CrosstableResponse,
  CrosstableRoundRobin,
  CrosstableSwiss,
  CrosstableTeam,
  CrosstableLegacy,
} from '@kingside/shared';

/**
 * KS-1736 / ADR-023 §2.10 (A12) — unit-тесты диспетчера crosstable.
 * Проверяют что по `tournamentType` рендерится нужный компонент,
 * а loading / error / unknown → fallback на legacy.
 */

const mockBroadcastApi = { get: vi.fn() };
vi.mock('../../api/broadcastApi', () => ({
  broadcastApi: {
    get: (...args: unknown[]) => mockBroadcastApi.get(...args),
  },
}));

const BASE = {
  sourceType: 'chess-results' as const,
  sourceUrl: 'https://chess-results.com/tnr1',
  fetchedAt: '2026-04-23T10:00:00.000Z',
  players: [
    { rank: 1, name: 'Alice', normalizedName: 'alice', points: 3, gamesPlayed: 3 },
    { rank: 2, name: 'Bob', normalizedName: 'bob', points: 2, gamesPlayed: 3 },
  ],
};

function roundRobinFixture(): CrosstableRoundRobin {
  return {
    ...BASE,
    tournamentType: 'round-robin',
    matrix: [
      [{ result: null }, { result: 'win', color: 'white' }],
      [{ result: 'loss', color: 'black' }, { result: null }],
    ],
  };
}

function swissFixture(): CrosstableSwiss {
  return {
    ...BASE,
    tournamentType: 'swiss',
    roundCount: 3,
    pairings: [
      [{ result: 'win', color: 'white', opponentRank: 2 }],
      [{ result: 'loss', color: 'black', opponentRank: 1 }],
    ],
  };
}

function teamFixture(type: 'team-swiss' | 'team-round-robin'): CrosstableTeam {
  return {
    ...BASE,
    tournamentType: type,
    teams: [
      { name: 'Red', rank: 1, points: 5 },
      { name: 'Blue', rank: 2, points: 3 },
    ],
  };
}

function legacyFixture(): CrosstableLegacy {
  return {
    ...BASE,
    sourceType: 'internal-fallback',
    sourceUrl: null,
    fetchedAt: null,
    tournamentType: 'unknown',
    reason: 'standings_url not on chess-results.com',
  };
}

beforeEach(() => {
  mockBroadcastApi.get.mockReset();
});

describe('BroadcastCrosstable dispatcher', () => {
  it('показывает индикатор загрузки пока запрос не ответил', () => {
    // never-resolving promise
    mockBroadcastApi.get.mockImplementation(() => new Promise<CrosstableResponse>(() => {}));

    renderWithProviders(<BroadcastCrosstable broadcastId="b1" broadcastTitle="Test" />);

    expect(screen.getByTestId('broadcast-crosstable-loading')).toBeInTheDocument();
  });

  it('рендерит <RoundRobinCrosstable> для tournamentType=round-robin', async () => {
    mockBroadcastApi.get.mockResolvedValueOnce(roundRobinFixture());

    renderWithProviders(<BroadcastCrosstable broadcastId="b1" broadcastTitle="Test" />);

    await waitFor(() => expect(screen.getByTestId('round-robin-crosstable')).toBeInTheDocument());
    expect(mockBroadcastApi.get).toHaveBeenCalledWith('/b1/crosstable');
  });

  it('рендерит <BroadcastSwissStandings> для tournamentType=swiss', async () => {
    mockBroadcastApi.get.mockResolvedValueOnce(swissFixture());

    renderWithProviders(<BroadcastCrosstable broadcastId="b1" broadcastTitle="Test" />);

    await waitFor(() => expect(screen.getByTestId('broadcast-swiss-standings')).toBeInTheDocument());
  });

  it('рендерит <TeamStandings> для tournamentType=team-swiss', async () => {
    mockBroadcastApi.get.mockResolvedValueOnce(teamFixture('team-swiss'));

    renderWithProviders(<BroadcastCrosstable broadcastId="b1" broadcastTitle="Test" />);

    await waitFor(() => expect(screen.getByTestId('team-standings')).toBeInTheDocument());
  });

  it('рендерит <TeamStandings> для tournamentType=team-round-robin', async () => {
    mockBroadcastApi.get.mockResolvedValueOnce(teamFixture('team-round-robin'));

    renderWithProviders(<BroadcastCrosstable broadcastId="b1" broadcastTitle="Test" />);

    await waitFor(() => expect(screen.getByTestId('team-standings')).toBeInTheDocument());
  });

  it('рендерит <LegacyStandings> для tournamentType=unknown', async () => {
    // Первый вызов — /crosstable, вернёт legacy. Далее LegacyStandings сам сходит
    // за /standings и /rounds — отдадим пустой ответ.
    mockBroadcastApi.get.mockImplementation((path: string) => {
      if (path === '/b1/crosstable') return Promise.resolve(legacyFixture());
      if (path === '/b1/standings') return Promise.resolve({ players: [] });
      if (path === '/b1/rounds') return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    renderWithProviders(<BroadcastCrosstable broadcastId="b1" broadcastTitle="Test" />);

    await waitFor(() => expect(screen.getByText(/standings not available yet/i)).toBeInTheDocument());
  });

  it('при ошибке загрузки /crosstable падает на <LegacyStandings>', async () => {
    mockBroadcastApi.get.mockImplementation((path: string) => {
      if (path === '/b1/crosstable') return Promise.reject(new Error('500 Internal'));
      if (path === '/b1/standings') return Promise.resolve({ players: [] });
      if (path === '/b1/rounds') return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    renderWithProviders(<BroadcastCrosstable broadcastId="b1" broadcastTitle="Test" />);

    await waitFor(() => expect(screen.getByText(/standings not available yet/i)).toBeInTheDocument());
  });
});
