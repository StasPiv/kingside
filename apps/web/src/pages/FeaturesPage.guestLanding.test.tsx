/**
 * KS-4646. Гостевой лендинг `/` (FeaturesPage variant='home') получает
 * две новые секции для SEO-перелинковки:
 *   1. `LecturesPromoSection` — карточки 3-4 публичных лекций.
 *   2. `CoachesPromo` (variant='compact') — карточки 2 тренеров.
 *
 * Проверяем, что в DOM присутствуют корневые data-testid этих секций
 * (заодно убеждаемся, что компонент рендерится без падений при
 * замоканных хуках).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

import { renderWithProviders } from '../test/test-utils';
import { FeaturesPage } from './FeaturesPage';

// `useLandingStats` дёргает `landingApi.getStats` — мокаем модуль,
// чтобы effect отстрелял без сети.
vi.mock('../api/landingApi', () => ({
  landingApi: {
    getStats: vi.fn().mockResolvedValue({
      onlineNow: 0,
      gamesInProgress: 0,
      totalGames: 0,
      registeredUsers: 0,
      totalPuzzlesSolved: 0,
    }),
  },
}));

// `usePublicLectures` (используется в LecturesPromoSection) — мокаем
// напрямую, чтобы не дёргать `/lectures/public` из теста и
// возвращать предсказуемый список.
vi.mock('../hooks/usePublicLectures', () => ({
  usePublicLectures: vi.fn().mockReturnValue({
    items: [
      {
        id: 'lec-1',
        ownerId: 'owner-1',
        title: 'Sicilian basics',
        description: null,
        scheduledAt: null,
        startedAt: '2026-06-10T15:30:00Z',
        endedAt: null,
        durationMs: 600_000,
        status: 'recorded',
        visibility: 'public',
        liveAnalysisId: null,
        recordingId: 'rec-1',
        mediaUrl: null,
        mediaKind: null,
        createdAt: '2026-06-10T15:30:00Z',
        updatedAt: '2026-06-10T15:40:00Z',
        liveAnalysis: null,
        disabledTools: [],
        hideMetricsTab: false,
        coach: { id: 'coach-1', username: 'magnus' },
      },
    ],
    total: 1,
    hasMore: false,
    loading: false,
    loadingMore: false,
    error: null,
    status: 'all',
    setStatus: vi.fn(),
    loadMore: vi.fn(),
    reload: vi.fn(),
  }),
}));

describe('FeaturesPage variant="home" — SEO-перелинковка KS-4646', () => {
  afterEach(() => {
    cleanup();
  });

  it('рендерит секцию-промо лекций со ссылками на /lectures/:id', () => {
    const { getByTestId, getAllByRole } = renderWithProviders(
      <FeaturesPage variant="home" />,
    );

    const lecturesSection = getByTestId('lectures-promo-section');
    expect(lecturesSection).toBeTruthy();

    // ссылка на конкретную лекцию из мока
    const links = getAllByRole('link');
    const lectureLink = links.find((a) =>
      a.getAttribute('href')?.startsWith('/lectures/lec-1'),
    );
    expect(lectureLink).toBeDefined();

    // ссылка «All lectures →» на каталог
    const catalogLink = links.find(
      (a) => a.getAttribute('href') === '/lectures',
    );
    expect(catalogLink).toBeDefined();
  });

  it('рендерит compact-секцию тренеров со ссылками /coach/Stanislav и /coach/Kingside', () => {
    const { getByTestId, getAllByRole } = renderWithProviders(
      <FeaturesPage variant="home" />,
    );

    const coachesSection = getByTestId('home-coaches-promo');
    expect(coachesSection).toBeTruthy();

    const links = getAllByRole('link');
    const stanislav = links.find(
      (a) => a.getAttribute('href') === '/coach/Stanislav',
    );
    const kingside = links.find(
      (a) => a.getAttribute('href') === '/coach/Kingside',
    );
    expect(stanislav).toBeDefined();
    expect(kingside).toBeDefined();
  });
});
