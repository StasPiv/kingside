import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderWithAuth, screen, waitFor } from '../../test/test-utils-auth';
import { OpeningTrainerLobbyPage } from './OpeningTrainerLobbyPage';
import { openingTrainerApi } from '../../api/openingTrainerApi';

vi.mock('../../api/openingTrainerApi', () => ({
  openingTrainerApi: {
    listRepertoires: vi.fn(),
    // KS-4179: после KS-4161 компонент дополнительно зовёт публичный
    // эндпоинт демо-репертуаров. Без этого mock'а — TypeError на
    // первом же рендере (listDemoRepertoires is not a function).
    listDemoRepertoires: vi.fn().mockResolvedValue([]),
  },
}));

const mockedApi = vi.mocked(openingTrainerApi);

describe('OpeningTrainerLobbyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockedApi.listRepertoires.mockReturnValue(new Promise(() => {}));
    renderWithAuth(<OpeningTrainerLobbyPage />, { user: { id: 'u1', username: 'tester' } });
    expect(screen.getByTestId('opening-trainer-lobby')).toBeInTheDocument();
  });

  it('renders empty state when no repertoires', async () => {
    mockedApi.listRepertoires.mockResolvedValue({ repertoires: [] });
    renderWithAuth(<OpeningTrainerLobbyPage />, { user: { id: 'u1', username: 'tester' } });
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-lobby-empty')).toBeInTheDocument(),
    );
  });

  it('renders list of repertoires', async () => {
    mockedApi.listRepertoires.mockResolvedValue({
      repertoires: [
        {
          id: 'r1',
          ownerId: 'u1',
          title: 'Caro-Kann',
          description: 'For Black',
          // KS-3302: side обязателен в OpeningRepertoireDto.
          side: 'black',
          nodeCount: 42,
          edgeCount: 60,
          maxDepth: 12,
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      ],
    });
    renderWithAuth(<OpeningTrainerLobbyPage />, { user: { id: 'u1', username: 'tester' } });
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-card-r1')).toBeInTheDocument(),
    );
    expect(screen.getByText('Caro-Kann')).toBeInTheDocument();
    expect(screen.getByText('For Black')).toBeInTheDocument();
  });

  it('renders error when API throws', async () => {
    mockedApi.listRepertoires.mockRejectedValue(new Error('boom'));
    renderWithAuth(<OpeningTrainerLobbyPage />, { user: { id: 'u1', username: 'tester' } });
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-lobby-error')).toBeInTheDocument(),
    );
  });
});
