import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  BroadcastBracketResponse,
  BroadcastRoundItem,
  BroadcastRoundsResponse,
} from '@kingside/shared';

import { renderWithProviders, screen, waitFor } from '../../test/test-utils';

const broadcastApiMock = { get: vi.fn() };

vi.mock('../../api/broadcastApi', () => ({
  broadcastApi: {
    get: (...a: unknown[]) => broadcastApiMock.get(...a),
  },
}));

vi.mock('./BroadcastCrosstable', () => ({
  BroadcastCrosstable: ({
    broadcastId,
  }: {
    broadcastId: string;
    broadcastTitle: string;
  }) => <div data-testid="crosstable-mock" data-broadcast-id={broadcastId} />,
}));

vi.mock('./PlayoffBracket', () => ({
  PlayoffBracket: ({
    games,
    links,
  }: {
    games: Array<{ id: string }>;
    links?: Array<{ kind: string }>;
  }) => (
    <div
      data-testid="playoff-bracket-mock"
      data-games-count={games.length}
      data-links-count={links?.length ?? 0}
    />
  ),
}));

import { BroadcastStandings } from './BroadcastStandings';

beforeEach(() => {
  broadcastApiMock.get.mockReset();
});

function makeBracket(
  type: BroadcastBracketResponse['tournamentType'],
  gamesCount: number,
): BroadcastBracketResponse {
  return {
    broadcastId: 'bc-1',
    tournamentType: type,
    games: Array.from({ length: gamesCount }, (_, i) => ({
      id: `g-${i}`,
      lichessGameId: `lg-${i}`,
      whitePlayer: 'A',
      blackPlayer: 'B',
      whiteElo: 2500,
      blackElo: 2500,
      result: '*',
      pgn: null,
      currentFen: null,
      updatedAt: '2026-04-24T10:00:00.000Z',
      bracketStage: type === 'playoff' ? 'quarter' : null,
      bracketPairId: type === 'playoff' ? `p:${i}` : null,
      matchScore: null,
    })),
    links: [],
  };
}

function makeRounds(
  ...types: Array<BroadcastRoundItem['tournamentType']>
): BroadcastRoundsResponse {
  return {
    data: types.map((tt, i) => ({
      id: `r-${i}`,
      lichessRoundId: `lr-${i}`,
      name: `Round ${i + 1}`,
      startsAt: null,
      status: 'finished',
      tournamentType: tt,
    })),
  };
}

/**
 * Хелпер для двух параллельных вызовов: /bracket + /rounds.
 * BroadcastStandings делает их через `Promise.allSettled`, маршрутизируем
 * mock по URL.
 */
function mockApi(
  bracket: BroadcastBracketResponse | Error | null,
  rounds: BroadcastRoundsResponse | Error | null,
) {
  broadcastApiMock.get.mockImplementation((url: string) => {
    if (url.endsWith('/bracket')) {
      if (bracket instanceof Error) return Promise.reject(bracket);
      if (bracket === null) return new Promise(() => {});
      return Promise.resolve(bracket);
    }
    if (url.endsWith('/rounds')) {
      if (rounds instanceof Error) return Promise.reject(rounds);
      if (rounds === null) return new Promise(() => {});
      return Promise.resolve(rounds);
    }
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });
}

describe('<BroadcastStandings> KS-2567', () => {
  it('загрузка → показывает loading-индикатор', () => {
    broadcastApiMock.get.mockReturnValue(new Promise(() => {}));
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    expect(
      screen.getByTestId('broadcast-standings-loading'),
    ).toBeInTheDocument();
  });

  it('hybrid (round_robin + playoff) → рендер ОБЕИХ секций: crosstable сверху + PlayoffBracket снизу', async () => {
    mockApi(
      makeBracket('playoff', 3),
      makeRounds('round_robin', 'round_robin', 'playoff'),
    );
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('crosstable-mock')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('playoff-bracket-mock')).toBeInTheDocument();
    expect(
      screen.getByTestId('broadcast-playoff-section'),
    ).toBeInTheDocument();
    // Заголовок «Playoff» виден над bracket'ом, потому что выше есть
    // crosstable.
    expect(
      screen.getByTestId('broadcast-playoff-section').textContent,
    ).toMatch(/Playoff|Плей-офф/);
  });

  it('hybrid (swiss + playoff) → ОБЕИ секции', async () => {
    mockApi(makeBracket('playoff', 2), makeRounds('swiss', 'swiss', 'playoff'));
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('crosstable-mock')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('playoff-bracket-mock')).toBeInTheDocument();
  });

  it('pure round_robin (без playoff) → только crosstable', async () => {
    mockApi(makeBracket('round_robin', 0), makeRounds('round_robin', 'round_robin'));
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('crosstable-mock')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('playoff-bracket-mock')).not.toBeInTheDocument();
  });

  it('pure swiss → только crosstable', async () => {
    mockApi(makeBracket('swiss', 0), makeRounds('swiss', 'swiss'));
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('crosstable-mock')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('playoff-bracket-mock')).not.toBeInTheDocument();
  });

  it('pure playoff (single-stage knockout) → только PlayoffBracket', async () => {
    mockApi(makeBracket('playoff', 4), makeRounds('playoff', 'playoff'));
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('playoff-bracket-mock')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('crosstable-mock')).not.toBeInTheDocument();
    // Заголовок секции скрыт, когда нет конкуренции с crosstable.
    expect(
      screen.queryByTestId('broadcast-playoff-section')!.textContent,
    ).not.toMatch(/Playoff|Плей-офф/);
  });

  it('unknown tournament type → fallback crosstable, bracket скрыт', async () => {
    mockApi(makeBracket('unknown', 0), makeRounds('unknown', 'unknown'));
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('crosstable-mock')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('playoff-bracket-mock')).not.toBeInTheDocument();
  });

  it('playoff с пустым games → bracket НЕ рендерится, crosstable показывается', async () => {
    mockApi(
      makeBracket('playoff', 0),
      makeRounds('round_robin', 'round_robin'),
    );
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('crosstable-mock')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('playoff-bracket-mock')).not.toBeInTheDocument();
  });

  it('ошибка /bracket → fallback на crosstable (страница не ломается)', async () => {
    mockApi(new Error('boom'), makeRounds('round_robin'));
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('crosstable-mock')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('playoff-bracket-mock')).not.toBeInTheDocument();
  });

  it('ошибка /rounds, но /bracket=playoff → bracket показан (fallback hybrid-detection через bracket.tournamentType)', async () => {
    mockApi(makeBracket('playoff', 2), new Error('rounds 500'));
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    // /rounds упал → hasMain=false; tournamentType='playoff' и
    // games.length>0 → bracket показан, crosstable скрыт (single-stage).
    await waitFor(() =>
      expect(screen.getByTestId('playoff-bracket-mock')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('crosstable-mock')).not.toBeInTheDocument();
  });

  it('запрос идёт на корректные endpoints (/bracket + /rounds)', async () => {
    mockApi(makeBracket('round_robin', 0), makeRounds('round_robin'));
    renderWithProviders(
      <BroadcastStandings broadcastId="abc-123" broadcastTitle="T" />,
    );
    await waitFor(() => {
      expect(broadcastApiMock.get).toHaveBeenCalledWith('/abc-123/bracket');
      expect(broadcastApiMock.get).toHaveBeenCalledWith('/abc-123/rounds');
    });
  });
});
