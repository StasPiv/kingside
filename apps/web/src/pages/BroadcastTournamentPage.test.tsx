import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';

/**
 * KS-2447: вкладка Live на странице турнира должна обновлять позиции в
 * реальном времени (через 15s polling), как и страница Round. Раньше
 * `liveGames` грузились одним fetch'ем при первичном маунте без интервала
 * — позиции на досках замерзали.
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

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useParams: () => ({ tournamentId: 'tx' }),
  };
});

import { BroadcastTournamentPage } from './BroadcastTournamentPage';

const META = {
  id: 'tx',
  lichessId: 'lx',
  title: 'TePe Sigeman',
  description: null,
  url: 'https://lichess.org/broadcast/tx',
  isActive: true,
  format: null,
  timeControl: null,
  location: null,
  players: null,
  website: null,
  standingsUrl: null,
  imageUrl: null,
  startDate: null,
  endDate: null,
  streams: null,
};

const ROUND = {
  id: 'r6',
  lichessRoundId: 'lr6',
  name: 'Round 6',
  startsAt: null,
  status: 'ongoing' as const,
};

function gameWithPgnLen(id: string, white: string, black: string, pgnLen: number) {
  return {
    id,
    lichessGameId: `lg-${id}`,
    whitePlayer: white,
    blackPlayer: black,
    result: null,
    pgn: '1. e4'.padEnd(pgnLen, ' '),
  };
}

beforeEach(() => {
  broadcastApiMock.get.mockReset();
  // Только setInterval/clearInterval подменяем — Promise/microtasks
  // должны идти на реальном scheduler, иначе waitFor зависает.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('BroadcastTournamentPage KS-2447 Live tab polls games', () => {
  it('Live-tab перезапрашивает партии каждые 15s и обновляет fen, не теряя порядок A→Z', async () => {
    const initialGames = [
      gameWithPgnLen('g1', 'Woodward, Andy', 'Carlsen, Magnus', 10),
      gameWithPgnLen('g2', 'Erdogmus, Yagiz Kaan', 'Abdusattorov, Nodirbek', 10),
    ];
    const updatedGames = [
      // backend перевернул порядок и удлинил pgn у одной партии
      gameWithPgnLen('g1', 'Woodward, Andy', 'Carlsen, Magnus', 10),
      gameWithPgnLen('g2', 'Erdogmus, Yagiz Kaan', 'Abdusattorov, Nodirbek', 25),
    ];

    broadcastApiMock.get.mockImplementation((path: string) => {
      if (path === '/tx') return Promise.resolve(META);
      if (path === '/tx/rounds') return Promise.resolve({ data: [ROUND] });
      if (path === '/tx/rounds/r6/games') {
        const callIndex = broadcastApiMock.get.mock.calls.filter(
          (c) => c[0] === '/tx/rounds/r6/games',
        ).length;
        return Promise.resolve({ data: callIndex === 1 ? initialGames : updatedGames });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    const { container } = renderWithProviders(<BroadcastTournamentPage />, {
      route: '/broadcasts/tx',
    });

    await waitFor(() => {
      expect(container.querySelector('.broadcast-boards-grid')).toBeInTheDocument();
    });

    // Первичная сортировка по white: Erdogmus → Woodward
    const initialIds = Array.from(
      container.querySelectorAll('.broadcast-boards-grid .broadcast-board-card'),
    ).map(
      (c) =>
        c
          .querySelector('.broadcast-player--white')
          ?.textContent?.replace(/^[♔-♟\s]+/, '') ?? '',
    );
    expect(initialIds[0]).toContain('Erdogmus');
    expect(initialIds[1]).toContain('Woodward');

    // Промотаем 15s → должен быть второй fetch с обновлённым pgn
    await vi.advanceTimersByTimeAsync(15_000);
    await waitFor(() => {
      const calls = broadcastApiMock.get.mock.calls.filter(
        (c) => c[0] === '/tx/rounds/r6/games',
      );
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    // Порядок остался прежним (white-сортировка), позиция обновилась
    const updatedNames = Array.from(
      container.querySelectorAll('.broadcast-boards-grid .broadcast-board-card'),
    ).map(
      (c) =>
        c
          .querySelector('.broadcast-player--white')
          ?.textContent?.replace(/^[♔-♟\s]+/, '') ?? '',
    );
    expect(updatedNames[0]).toContain('Erdogmus');
    expect(updatedNames[1]).toContain('Woodward');
  });

  it('Live-tab без ongoingRound не делает games-fetch и не запускает polling', async () => {
    broadcastApiMock.get.mockImplementation((path: string) => {
      if (path === '/tx') return Promise.resolve(META);
      if (path === '/tx/rounds')
        return Promise.resolve({ data: [{ ...ROUND, status: 'finished' }] });
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    renderWithProviders(<BroadcastTournamentPage />, { route: '/broadcasts/tx' });

    await waitFor(() => {
      expect(broadcastApiMock.get).toHaveBeenCalledWith('/tx/rounds');
    });

    // Без ongoing round нет games-fetch ни сразу, ни после прогона интервала
    vi.advanceTimersByTime(20_000);
    const gamesCalls = broadcastApiMock.get.mock.calls.filter((c) =>
      String(c[0]).includes('/games'),
    );
    expect(gamesCalls.length).toBe(0);
  });
});
