import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BroadcastBracketResponse } from '@kingside/shared';

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
  }) => (
    <div data-testid="crosstable-mock" data-broadcast-id={broadcastId} />
  ),
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

function mockBracketResponse(
  type: BroadcastBracketResponse['tournamentType'],
  games: number,
  links: number,
) {
  const response: BroadcastBracketResponse = {
    broadcastId: 'bc-1',
    tournamentType: type,
    games: Array.from({ length: games }, (_, i) => ({
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
    links: Array.from({ length: links }, (_, i) => ({
      fromPairId: `p:${i}`,
      toPairId: `p:${i + 1}`,
      kind: 'winner' as const,
    })),
  };
  broadcastApiMock.get.mockResolvedValueOnce(response);
  return response;
}

describe('<BroadcastStandings>', () => {
  it('загрузка → показывает loading-индикатор', () => {
    broadcastApiMock.get.mockReturnValue(new Promise(() => {}));
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    expect(screen.getByTestId('broadcast-standings-loading')).toBeInTheDocument();
  });

  it('tournamentType=playoff → PlayoffBracket с games/links из ответа', async () => {
    mockBracketResponse('playoff', 3, 2);
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('playoff-bracket-mock')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('playoff-bracket-mock')).toHaveAttribute(
      'data-games-count',
      '3',
    );
    expect(screen.getByTestId('playoff-bracket-mock')).toHaveAttribute(
      'data-links-count',
      '2',
    );
    expect(screen.queryByTestId('crosstable-mock')).not.toBeInTheDocument();
  });

  it('tournamentType=round_robin → crosstable, НЕ PlayoffBracket', async () => {
    mockBracketResponse('round_robin', 0, 0);
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('crosstable-mock')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('playoff-bracket-mock')).not.toBeInTheDocument();
  });

  it('tournamentType=swiss → crosstable', async () => {
    mockBracketResponse('swiss', 0, 0);
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('crosstable-mock')).toBeInTheDocument(),
    );
  });

  it('tournamentType=unknown → crosstable', async () => {
    mockBracketResponse('unknown', 0, 0);
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('crosstable-mock')).toBeInTheDocument(),
    );
  });

  it('playoff с пустым games → fallback на crosstable', async () => {
    mockBracketResponse('playoff', 0, 0);
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('crosstable-mock')).toBeInTheDocument(),
    );
  });

  it('ошибка /bracket → fallback на crosstable (страница не ломается)', async () => {
    broadcastApiMock.get.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(
      <BroadcastStandings broadcastId="bc-1" broadcastTitle="T" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('crosstable-mock')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('playoff-bracket-mock')).not.toBeInTheDocument();
  });

  it('запрос идёт на корректный endpoint /:id/bracket', async () => {
    mockBracketResponse('round_robin', 0, 0);
    renderWithProviders(
      <BroadcastStandings broadcastId="abc-123" broadcastTitle="T" />,
    );
    await waitFor(() =>
      expect(broadcastApiMock.get).toHaveBeenCalledWith('/abc-123/bracket'),
    );
  });
});
