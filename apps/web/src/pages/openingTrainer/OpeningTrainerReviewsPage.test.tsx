import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders, screen, waitFor, userEvent } from '../../test/test-utils';
import { OpeningTrainerReviewsPage } from './OpeningTrainerReviewsPage';
import { openingTrainerApi } from '../../api/openingTrainerApi';
import type { GetOpeningReviewsDueResponse } from '@kingside/shared';

vi.mock('../../api/openingTrainerApi', () => ({
  openingTrainerApi: {
    getReviewsDue: vi.fn(),
    startSession: vi.fn(),
  },
}));
const mockedApi = vi.mocked(openingTrainerApi);

type Line = GetOpeningReviewsDueResponse['lines'][number];
function makeLine(overrides: Partial<Line>): Line {
  return {
    id: 'l1',
    repertoireId: 'r1',
    repertoireTitle: 'Caro-Kann',
    pathHash: 'h',
    pathUci: ['e2e4'],
    pathLength: 1,
    correctCount: 5,
    wrongCount: 0,
    consecutiveCorrect: 3,
    lastPlayedAt: '2026-05-20T00:00:00Z',
    masteredAt: '2026-05-21T00:00:00Z',
    sm2DueAt: '2026-05-24T00:00:00Z',
    sm2Interval: 1,
    sm2Easiness: 2.5,
    sm2Reps: 1,
    orphaned: false,
    status: 'due',
    ...overrides,
  };
}

function renderReviews() {
  return renderWithProviders(
    <Routes>
      <Route path="/opening-trainer/reviews" element={<OpeningTrainerReviewsPage />} />
    </Routes>,
    { route: '/opening-trainer/reviews' },
  );
}

describe('OpeningTrainerReviewsPage (KS-3298 F4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('пусто → empty-state', async () => {
    mockedApi.getReviewsDue.mockResolvedValue({ lines: [] });
    renderReviews();
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-reviews-empty')).toBeInTheDocument(),
    );
  });

  it('группирует линии по репертуару', async () => {
    mockedApi.getReviewsDue.mockResolvedValue({
      lines: [
        makeLine({ id: 'l1', repertoireId: 'r1', repertoireTitle: 'Caro' }),
        makeLine({ id: 'l2', repertoireId: 'r1', pathUci: ['d2d4'] }),
        makeLine({ id: 'l3', repertoireId: 'r2', repertoireTitle: 'Sicilian' }),
      ],
    });
    renderReviews();
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-reviews-group-r1')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('opening-trainer-reviews-group-r2')).toBeInTheDocument();
    // Линии под группой r1: 2 шт.
    expect(screen.getByTestId('opening-trainer-reviews-line-l1')).toBeInTheDocument();
    expect(screen.getByTestId('opening-trainer-reviews-line-l2')).toBeInTheDocument();
  });

  it('клик по линии стартует review-сессию её репертуара', async () => {
    mockedApi.getReviewsDue.mockResolvedValue({
      lines: [makeLine({ id: 'l1', repertoireId: 'r1', pathUci: ['e2e4'] })],
    });
    mockedApi.startSession.mockRejectedValue(new Error('boom')); // не редиректим
    renderReviews();
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-reviews-line-l1')).toBeInTheDocument(),
    );
    const btn = screen
      .getByTestId('opening-trainer-reviews-line-l1')
      .querySelector('button')!;
    await userEvent.click(btn);
    await waitFor(() =>
      expect(mockedApi.startSession).toHaveBeenCalledWith('r1', {
        side: 'white',
        mode: 'review',
        repeatMode: 'complete',
      }),
    );
  });

  it('error при загрузке отображается', async () => {
    mockedApi.getReviewsDue.mockRejectedValue(new Error('boom'));
    renderReviews();
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-reviews-error')).toBeInTheDocument(),
    );
  });
});
