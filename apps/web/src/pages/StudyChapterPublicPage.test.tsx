import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';

import { renderWithProviders, screen } from '../test/test-utils';

/**
 * KS-2829 (KS-2815 §B.5): smoke-тесты публичной страницы главы.
 */

const getPublicChapterMock = vi.fn();
vi.mock('../api/studiesApi', () => ({
  studiesApi: {
    getPublicChapter: (id: string) => getPublicChapterMock(id),
  },
}));

const authState: { user: { id: string; username: string } | null } = {
  user: null,
};
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user, loading: false }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useParams: () => ({ chapterId: 'ch1' }),
  };
});

vi.mock('react-chessboard', () => ({
  Chessboard: ({ options }: { options: { position?: string } }) => (
    <div data-testid="chessboard-mock" data-position={options.position} />
  ),
}));

import { StudyChapterPublicPage } from './StudyChapterPublicPage';

const RESPONSE = {
  chapter: {
    id: 'ch1',
    studyId: 's1',
    name: 'Public chapter',
    orderIdx: 1,
    pgn: '1. e4 e5',
    startFen: null,
    orientation: 'white' as const,
    mode: 'analysis',
    createdAt: '2026-05-12T10:00:00.000Z',
    updatedAt: '2026-05-12T10:00:00.000Z',
  },
  study: {
    id: 's1',
    slug: 'demo',
    name: 'Demo study',
    ownerId: 'u1',
  },
};

beforeEach(() => {
  getPublicChapterMock.mockReset();
  getPublicChapterMock.mockResolvedValue(RESPONSE);
  authState.user = null;
});

describe('StudyChapterPublicPage (KS-2829)', () => {
  it('anonymous: загружает главу через getPublicChapter и рендерит', async () => {
    renderWithProviders(<StudyChapterPublicPage />, {
      route: '/studies/c/ch1',
    });
    await waitFor(() =>
      expect(getPublicChapterMock).toHaveBeenCalledWith('ch1'),
    );
    expect(screen.getByTestId('study-public-page').getAttribute('data-state')).toBe('ready');
    expect(screen.getByTestId('study-public-name')).toHaveTextContent('Public chapter');
    expect(screen.getByTestId('study-public-board')).toBeInTheDocument();
    expect(screen.getByTestId('study-public-moves')).toBeInTheDocument();
  });

  it('не-owner: «Открыть в редакторе» НЕ показывается', async () => {
    authState.user = { id: 'other', username: 'other' };
    renderWithProviders(<StudyChapterPublicPage />, {
      route: '/studies/c/ch1',
    });
    await waitFor(() => expect(getPublicChapterMock).toHaveBeenCalled());
    expect(
      screen.queryByTestId('study-public-open-editor'),
    ).not.toBeInTheDocument();
  });

  it('owner: «Открыть в редакторе» виден и ведёт на /studies/:slug/:chapterId', async () => {
    authState.user = { id: 'u1', username: 'owner' };
    renderWithProviders(<StudyChapterPublicPage />, {
      route: '/studies/c/ch1',
    });
    await waitFor(() => expect(getPublicChapterMock).toHaveBeenCalled());
    const editor = await waitFor(() =>
      screen.getByTestId('study-public-open-editor'),
    );
    expect(editor.getAttribute('href')).toBe('/studies/demo/ch1');
  });

  it('404 / приватная глава → error-стейт', async () => {
    getPublicChapterMock.mockRejectedValue(new Error('not found'));
    renderWithProviders(<StudyChapterPublicPage />, {
      route: '/studies/c/ch1',
    });
    await waitFor(() =>
      expect(screen.getByTestId('study-public-error')).toBeInTheDocument(),
    );
  });

  it('навигация: кнопки first/prev/next/last рендерятся и кликабельны', async () => {
    renderWithProviders(<StudyChapterPublicPage />, {
      route: '/studies/c/ch1',
    });
    await waitFor(() =>
      expect(screen.getByTestId('study-public-board')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('study-public-nav-first')).toBeInTheDocument();
    expect(screen.getByTestId('study-public-nav-prev')).toBeInTheDocument();
    expect(screen.getByTestId('study-public-nav-next')).toBeInTheDocument();
    expect(screen.getByTestId('study-public-nav-last')).toBeInTheDocument();
  });
});
