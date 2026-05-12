import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders, screen } from '../test/test-utils';

/**
 * KS-2874 (ADR-060 §3.3 R4 FM5) — smoke-тесты gamebook reader.
 */

const getPublicChapterMock = vi.fn();
const getBySlugMock = vi.fn();
const getChapterMock = vi.fn();
vi.mock('../api/studiesApi', () => ({
  studiesApi: {
    getPublicChapter: (chId: string) => getPublicChapterMock(chId),
    getBySlug: (slug: string) => getBySlugMock(slug),
    getChapter: (slug: string, chId: string) => getChapterMock(slug, chId),
  },
}));

let routeParams: Record<string, string | undefined> = {
  slug: 's',
  chapterId: 'ch1',
};
vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => routeParams,
  };
});

vi.mock('react-chessboard', () => ({
  Chessboard: ({ options }: { options: { position?: string } }) => (
    <div data-testid="chessboard-mock" data-position={options.position} />
  ),
}));

import { GamebookReaderPage } from './GamebookReaderPage';

const STUDY = {
  id: 's1',
  ownerId: 'u1',
  slug: 's',
  name: 'Demo',
  description: null,
  isPublic: true,
  visibility: 'public',
  topics: [],
  likes: 0,
  chaptersCount: 1,
  createdAt: '2026-05-12T10:00:00.000Z',
  updatedAt: '2026-05-12T10:00:00.000Z',
};

const CHAPTER = {
  id: 'ch1',
  studyId: 's1',
  name: 'Lesson 1',
  orderIdx: 1,
  pgn: '1. e4 e5',
  startFen: null,
  orientation: 'white' as const,
  mode: 'gamebook',
  concealPly: null,
  gamebook: {
    intro: 'Welcome to the lesson.',
    byUci: {
      e2e4: { hint: 'Open the centre.', success: 'Well done!' },
      e7e5: { success: 'Black responds symmetrically.' },
    },
  },
  createdAt: '2026-05-12T10:00:00.000Z',
  updatedAt: '2026-05-12T10:00:00.000Z',
};

beforeEach(() => {
  getPublicChapterMock.mockReset();
  getBySlugMock.mockReset();
  getChapterMock.mockReset();
  getPublicChapterMock.mockResolvedValue({ study: STUDY, chapter: CHAPTER });
  getBySlugMock.mockResolvedValue({ study: STUDY, chapters: [] });
  getChapterMock.mockResolvedValue(CHAPTER);
  routeParams = { slug: 's', chapterId: 'ch1' };
});

describe('GamebookReaderPage (KS-2874 / KS-2907)', () => {
  it('slug-роут → авторизованный путь getBySlug+getChapter (KS-2907)', async () => {
    renderWithProviders(<GamebookReaderPage />, {
      route: '/studies/s/ch1/play',
    });
    await waitFor(() => expect(getChapterMock).toHaveBeenCalledWith('s', 'ch1'));
    expect(getBySlugMock).toHaveBeenCalledWith('s');
    expect(getPublicChapterMock).not.toHaveBeenCalled();
    expect(
      screen.getByTestId('gamebook-reader-page').getAttribute('data-state'),
    ).toBe('ready');
    expect(screen.getByTestId('gamebook-reader-intro')).toBeInTheDocument();
    expect(screen.getByText('Welcome to the lesson.')).toBeInTheDocument();
    expect(screen.getByTestId('gamebook-reader-start')).toBeInTheDocument();
    expect(
      screen.getByTestId('gamebook-reader-page').getAttribute('data-phase'),
    ).toBe('intro');
  });

  it('/c/-роут (без slug) → public-endpoint getPublicChapter (анонимный)', async () => {
    routeParams = { chapterId: 'ch1' };
    renderWithProviders(<GamebookReaderPage />, {
      route: '/studies/c/ch1/play',
    });
    await waitFor(() =>
      expect(getPublicChapterMock).toHaveBeenCalledWith('ch1'),
    );
    expect(getBySlugMock).not.toHaveBeenCalled();
    expect(getChapterMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('gamebook-reader-intro')).toBeInTheDocument();
  });

  it('клик «Старт» → phase=playing, intro исчезает, feedback показывается', async () => {
    renderWithProviders(<GamebookReaderPage />, {
      route: '/studies/s/ch1/play',
    });
    await waitFor(() => expect(getChapterMock).toHaveBeenCalledWith('s', 'ch1'));
    fireEvent.click(screen.getByTestId('gamebook-reader-start'));
    expect(
      screen.getByTestId('gamebook-reader-page').getAttribute('data-phase'),
    ).toBe('playing');
    expect(screen.queryByTestId('gamebook-reader-intro')).toBeNull();
    expect(screen.getByTestId('gamebook-reader-feedback')).toBeInTheDocument();
  });

  it('error state → fallback с «Chapter not found»', async () => {
    getChapterMock.mockRejectedValue(new Error('boom'));
    renderWithProviders(<GamebookReaderPage />, {
      route: '/studies/s/ch1/play',
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('gamebook-reader-page').getAttribute('data-state'),
      ).toBe('error'),
    );
    expect(screen.getByTestId('gamebook-reader-error')).toBeInTheDocument();
  });

  it('warning отображается если глава не gamebook-режима', async () => {
    getChapterMock.mockResolvedValue({
      ...CHAPTER,
      mode: 'analysis',
      gamebook: null,
    });
    renderWithProviders(<GamebookReaderPage />, {
      route: '/studies/s/ch1/play',
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('gamebook-reader-page').getAttribute('data-state'),
      ).toBe('ready'),
    );
    expect(
      screen.getByTestId('gamebook-reader-not-gamebook'),
    ).toBeInTheDocument();
  });
});
