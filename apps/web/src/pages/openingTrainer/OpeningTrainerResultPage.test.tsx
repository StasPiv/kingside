import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { OpeningTrainerResultPage } from './OpeningTrainerResultPage';
import { openingTrainerApi } from '../../api/openingTrainerApi';
import type { OpeningTrainerSessionDto } from '@kingside/shared';

vi.mock('../../api/openingTrainerApi', () => ({
  openingTrainerApi: { getSession: vi.fn() },
}));
const mockedApi = vi.mocked(openingTrainerApi);

function makeSession(overrides: Partial<OpeningTrainerSessionDto> = {}): OpeningTrainerSessionDto {
  return {
    id: 's1',
    repertoireId: 'r1',
    side: 'white',
    mode: 'learn',
    repeatMode: 'complete',
    status: 'finished',
    currentFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    currentPath: [],
    score: 42,
    movesPlayed: 10,
    correctMoves: 8,
    wrongMoves: 2,
    hintsUsed: 1,
    startedAt: '2026-05-23T00:00:00Z',
    lastActivityAt: '2026-05-23T00:01:00Z',
    finishedAt: '2026-05-23T00:01:00Z',
    ...overrides,
  };
}

describe('OpeningTrainerResultPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads session via API when state is empty', async () => {
    mockedApi.getSession.mockResolvedValue({ session: makeSession() });
    renderWithProviders(
      <Routes>
        <Route
          path="/opening-trainer/:id/session/:sid/result"
          element={<OpeningTrainerResultPage />}
        />
      </Routes>,
      { route: '/opening-trainer/r1/session/s1/result' },
    );

    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-result')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('opening-trainer-result-score')).toHaveTextContent('42');
    expect(mockedApi.getSession).toHaveBeenCalledWith('s1');
  });

  it('shows accuracy 80% when 8/10 correct', async () => {
    mockedApi.getSession.mockResolvedValue({ session: makeSession() });
    renderWithProviders(
      <Routes>
        <Route
          path="/opening-trainer/:id/session/:sid/result"
          element={<OpeningTrainerResultPage />}
        />
      </Routes>,
      { route: '/opening-trainer/r1/session/s1/result' },
    );
    await waitFor(() => expect(screen.getByText('80%')).toBeInTheDocument());
  });
});
