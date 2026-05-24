import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { OpeningTrainerLobbyPage } from './OpeningTrainerLobbyPage';
import { openingTrainerApi } from '../../api/openingTrainerApi';

vi.mock('../../api/openingTrainerApi', () => ({
  openingTrainerApi: {
    listRepertoires: vi.fn(),
  },
}));

const mockedApi = vi.mocked(openingTrainerApi);

describe('OpeningTrainerLobbyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockedApi.listRepertoires.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<OpeningTrainerLobbyPage />);
    expect(screen.getByTestId('opening-trainer-lobby')).toBeInTheDocument();
  });

  it('renders empty state when no repertoires', async () => {
    mockedApi.listRepertoires.mockResolvedValue({ repertoires: [] });
    renderWithProviders(<OpeningTrainerLobbyPage />);
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
    renderWithProviders(<OpeningTrainerLobbyPage />);
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-card-r1')).toBeInTheDocument(),
    );
    expect(screen.getByText('Caro-Kann')).toBeInTheDocument();
    expect(screen.getByText('For Black')).toBeInTheDocument();
  });

  it('renders error when API throws', async () => {
    mockedApi.listRepertoires.mockRejectedValue(new Error('boom'));
    renderWithProviders(<OpeningTrainerLobbyPage />);
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-lobby-error')).toBeInTheDocument(),
    );
  });
});
