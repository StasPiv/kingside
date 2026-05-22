import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Routes, Route } from 'react-router-dom';

import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { BroadcastGamePage } from './BroadcastGamePage';

/**
 * KS-3258 (3rd attempt): broadcast game page для forfeit-партий
 * (`[Termination "Unplayed"]` без movetext) рендерит full-page плашку
 * вместо редиректа на /analysis (где pipeline POST/getById терял
 * Termination header).
 */

const mockBroadcastApi = { get: vi.fn() };
vi.mock('../api/broadcastApi', () => ({
  broadcastApi: {
    get: (...args: unknown[]) => mockBroadcastApi.get(...args),
  },
}));

// openAnalysisFromPgn — мокаем, чтобы убедиться что для forfeit её НЕ зовут.
const mockOpenAnalysis = vi.fn(async () => {});
vi.mock('../utils/openAnalysisFromPgn', () => ({
  openAnalysisFromPgn: (...args: unknown[]) => mockOpenAnalysis(...args),
}));

function renderRoute(url: string) {
  // renderWithProviders сам оборачивает в MemoryRouter — передаём route.
  return renderWithProviders(
    <Routes>
      <Route
        path="/broadcasts/:tournamentId/:roundId/:gameId"
        element={<BroadcastGamePage />}
      />
      <Route path="/analysis/*" element={<div data-testid="analysis-page-stub" />} />
    </Routes>,
    { route: url },
  );
}

const TID = '6ff9fbe0-c94e-40be-aee0-115e576f4c9c';
const RID = '4ef77055-a84c-408c-bee1-6332ab253f40';
const GID = '881e1685-303f-4597-9a4d-6b50805c02be';

const FORFEIT_PGN = `[Event "Super Chess Classic Romania"]
[Site "Bucharest, Romania"]
[White "Firouzja, Alireza"]
[Black "Van Foreest, Jorden"]
[Result "0-1"]
[Termination "Unplayed"]

 0-1`;

const PLAYED_PGN = `[Event "Test"]
[Result "1-0"]

1. e4 e5 2. Nf3 1-0`;

beforeEach(() => {
  mockBroadcastApi.get.mockReset();
  mockOpenAnalysis.mockReset();
});

describe('<BroadcastGamePage> KS-3258 forfeit detection', () => {
  it('forfeit-партия → рендерит full-page плашку, НЕ зовёт openAnalysisFromPgn', async () => {
    mockBroadcastApi.get.mockImplementation((path: string) => {
      if (path === `/${TID}`) return Promise.resolve({ id: TID, title: 'GCT Romania' });
      if (path === `/${TID}/rounds`)
        return Promise.resolve({ data: [{ id: RID, name: 'Round 7' }] });
      if (path === `/${TID}/rounds/${RID}/games`)
        return Promise.resolve({
          data: [
            {
              id: GID,
              whitePlayer: 'Firouzja, Alireza',
              blackPlayer: 'Van Foreest, Jorden',
              result: '0-1',
              pgn: FORFEIT_PGN,
              currentFen: null,
            },
          ],
        });
      return Promise.resolve({ data: [] });
    });

    renderRoute(`/broadcasts/${TID}/${RID}/${GID}`);

    await waitFor(() =>
      expect(
        screen.getByTestId('broadcast-game-forfeit-page'),
      ).toBeInTheDocument(),
    );
    // Плашка отрисована — главный acceptance.
    expect(
      screen.getByTestId('broadcast-game-forfeit-placeholder'),
    ).toBeInTheDocument();
    // Имена игроков в заголовке.
    expect(screen.getByText(/Firouzja, Alireza.*Van Foreest, Jorden/)).toBeInTheDocument();
    // openAnalysisFromPgn НЕ зван (мы остановились до редиректа).
    expect(mockOpenAnalysis).not.toHaveBeenCalled();
  });

  it('обычная сыгранная партия → forfeit-page НЕ рендерится (PGN с ходами)', async () => {
    mockBroadcastApi.get.mockImplementation((path: string) => {
      if (path === `/${TID}`) return Promise.resolve({ id: TID, title: 'T' });
      if (path === `/${TID}/rounds`)
        return Promise.resolve({ data: [{ id: RID, name: 'R1' }] });
      if (path === `/${TID}/rounds/${RID}/games`)
        return Promise.resolve({
          data: [
            {
              id: GID,
              whitePlayer: 'A',
              blackPlayer: 'B',
              result: '1-0',
              pgn: PLAYED_PGN,
              currentFen: null,
            },
          ],
        });
      return Promise.resolve({ data: [] });
    });

    renderRoute(`/broadcasts/${TID}/${RID}/${GID}`);

    // Ждём пока промисы зарезолвятся (без forfeit-page mount'а).
    await waitFor(() =>
      expect(
        screen.queryByTestId('broadcast-game-forfeit-page'),
      ).toBeNull(),
    );
    // Forfeit-плашка точно не появилась — для PGN с ходами flow остался
    // как раньше (редирект на /analysis).
    expect(
      screen.queryByTestId('broadcast-game-forfeit-placeholder'),
    ).toBeNull();
  });
});
