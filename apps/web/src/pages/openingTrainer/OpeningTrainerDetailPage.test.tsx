import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders, screen, waitFor, userEvent } from '../../test/test-utils';
import { OpeningTrainerDetailPage } from './OpeningTrainerDetailPage';
import { openingTrainerApi } from '../../api/openingTrainerApi';

vi.mock('../../api/openingTrainerApi', () => ({
  openingTrainerApi: {
    getRepertoire: vi.fn(),
    startSession: vi.fn(),
    deleteRepertoire: vi.fn(),
  },
}));
const mockedApi = vi.mocked(openingTrainerApi);

describe('OpeningTrainerDetailPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads and renders repertoire detail', async () => {
    mockedApi.getRepertoire.mockResolvedValue({
      id: 'r1',
      ownerId: 'u1',
      title: 'Caro-Kann',
      description: null,
      nodeCount: 42,
      edgeCount: 60,
      maxDepth: 12,
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
      pgn: '',
      tree: {
        rootFen: 'start',
        nodes: {},
        meta: { nodeCount: 42, edgeCount: 60, maxDepth: 12 },
      },
    });
    renderWithProviders(
      <Routes>
        <Route
          path="/opening-trainer/:id"
          element={<OpeningTrainerDetailPage />}
        />
      </Routes>,
      { route: '/opening-trainer/r1' },
    );
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-detail')).toBeInTheDocument(),
    );
    expect(screen.getByText('Caro-Kann')).toBeInTheDocument();
    expect(screen.getByTestId('opening-trainer-start')).toBeInTheDocument();
  });

  it('starts session and shows error when API fails', async () => {
    mockedApi.getRepertoire.mockResolvedValue({
      id: 'r1',
      ownerId: 'u1',
      title: 'Test',
      description: null,
      nodeCount: 1,
      edgeCount: 1,
      maxDepth: 1,
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
      pgn: '',
      tree: {
        rootFen: 'start',
        nodes: {},
        meta: { nodeCount: 1, edgeCount: 1, maxDepth: 1 },
      },
    });
    mockedApi.startSession.mockRejectedValue(new Error('boom'));

    renderWithProviders(
      <Routes>
        <Route
          path="/opening-trainer/:id"
          element={<OpeningTrainerDetailPage />}
        />
      </Routes>,
      { route: '/opening-trainer/r1' },
    );
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-start')).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByTestId('opening-trainer-start'));
    await waitFor(() =>
      expect(mockedApi.startSession).toHaveBeenCalledWith('r1', {
        side: 'white',
        mode: 'learn',
        repeatMode: 'complete',
      }),
    );
  });
});
