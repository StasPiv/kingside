import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor, fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../test/test-utils';

/**
 * KS-2827 (KS-2815 §B.5, §A.4): smoke-тесты редактора главы.
 */

const getBySlugMock = vi.fn();
const getChapterMock = vi.fn();
const updateChapterMock = vi.fn();
const deleteChapterMock = vi.fn();
vi.mock('../api/studiesApi', () => ({
  studiesApi: {
    getBySlug: (slug: string) => getBySlugMock(slug),
    getChapter: (slug: string, chId: string) => getChapterMock(slug, chId),
    updateChapter: (slug: string, chId: string, req: unknown) =>
      updateChapterMock(slug, chId, req),
    deleteChapter: (slug: string, chId: string) =>
      deleteChapterMock(slug, chId),
  },
}));

const authState: { user: { id: string; username: string } | null } = {
  user: { id: 'u1', username: 'tester' },
};
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user, loading: false }),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useParams: () => ({ slug: 'demo', chapterId: 'ch1' }),
    useNavigate: () => navigateMock,
  };
});

// Chessboard сильно зависит от DOM/canvas — мокаем.
vi.mock('react-chessboard', () => ({
  Chessboard: ({ options }: { options: { position?: string } }) => (
    <div data-testid="chessboard-mock" data-position={options.position} />
  ),
}));

import { StudyChapterEditorPage } from './StudyChapterEditorPage';

const STUDY = {
  id: 's1',
  ownerId: 'u1',
  slug: 'demo',
  name: 'Demo study',
  description: null,
  isPublic: false,
  chaptersCount: 1,
  createdAt: '2026-05-12T10:00:00.000Z',
  updatedAt: '2026-05-12T10:00:00.000Z',
};

const CHAPTER = {
  id: 'ch1',
  studyId: 's1',
  name: 'Chapter 1',
  orderIdx: 1,
  pgn: '1. e4 e5',
  startFen: null,
  orientation: 'white' as const,
  mode: 'analysis',
  createdAt: '2026-05-12T10:00:00.000Z',
  updatedAt: '2026-05-12T10:00:00.000Z',
};

beforeEach(() => {
  getBySlugMock.mockReset();
  getChapterMock.mockReset();
  updateChapterMock.mockReset();
  deleteChapterMock.mockReset();
  navigateMock.mockReset();
  getBySlugMock.mockResolvedValue({ study: STUDY, chapters: [] });
  getChapterMock.mockResolvedValue(CHAPTER);
  authState.user = { id: 'u1', username: 'tester' };
});

describe('StudyChapterEditorPage (KS-2827)', () => {
  it('загружает study + chapter, рендерит editor', async () => {
    renderWithProviders(<StudyChapterEditorPage />, {
      route: '/studies/demo/ch1',
    });
    await waitFor(() => expect(getChapterMock).toHaveBeenCalledWith('demo', 'ch1'));
    expect(screen.getByTestId('study-editor-page').getAttribute('data-state')).toBe('ready');
    expect(screen.getByTestId('study-editor-name')).toHaveTextContent('Chapter 1');
    expect(screen.getByTestId('study-editor-board')).toBeInTheDocument();
    expect(screen.getByTestId('study-editor-moves')).toBeInTheDocument();
  });

  it('owner: видит actions (flip / delete)', async () => {
    renderWithProviders(<StudyChapterEditorPage />, {
      route: '/studies/demo/ch1',
    });
    await waitFor(() =>
      expect(screen.getByTestId('study-editor-actions')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('study-editor-action-flip')).toBeInTheDocument();
    expect(screen.getByTestId('study-editor-action-delete')).toBeInTheDocument();
  });

  it('не-owner: actions не рендерятся', async () => {
    authState.user = { id: 'other', username: 'other' };
    renderWithProviders(<StudyChapterEditorPage />, {
      route: '/studies/demo/ch1',
    });
    await waitFor(() => expect(getChapterMock).toHaveBeenCalled());
    expect(
      screen.queryByTestId('study-editor-actions'),
    ).not.toBeInTheDocument();
  });

  it('click по имени → input, Enter → updateChapter', async () => {
    updateChapterMock.mockResolvedValue({ ...CHAPTER, name: 'Renamed' });
    renderWithProviders(<StudyChapterEditorPage />, {
      route: '/studies/demo/ch1',
    });
    await waitFor(() =>
      expect(screen.getByTestId('study-editor-name')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('study-editor-name'));
    const input = await waitFor(() =>
      screen.getByTestId('study-editor-name-input'),
    );
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(updateChapterMock).toHaveBeenCalledWith('demo', 'ch1', {
        name: 'Renamed',
      }),
    );
  });

  it('flip orientation → updateChapter с другой ориентацией', async () => {
    updateChapterMock.mockResolvedValue({ ...CHAPTER, orientation: 'black' });
    renderWithProviders(<StudyChapterEditorPage />, {
      route: '/studies/demo/ch1',
    });
    await waitFor(() =>
      expect(screen.getByTestId('study-editor-action-flip')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('study-editor-action-flip'));
    await waitFor(() =>
      expect(updateChapterMock).toHaveBeenCalledWith('demo', 'ch1', {
        orientation: 'black',
      }),
    );
  });

  it('delete chapter (confirm=true) → deleteChapter + navigate', async () => {
    const orig = window.confirm;
    window.confirm = vi.fn(() => true) as typeof window.confirm;
    deleteChapterMock.mockResolvedValue(undefined);
    renderWithProviders(<StudyChapterEditorPage />, {
      route: '/studies/demo/ch1',
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('study-editor-action-delete'),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('study-editor-action-delete'));
    await waitFor(() =>
      expect(deleteChapterMock).toHaveBeenCalledWith('demo', 'ch1'),
    );
    expect(navigateMock).toHaveBeenCalledWith('/studies/demo', {
      replace: true,
    });
    window.confirm = orig;
  });

  it('chapter not found → error-стейт', async () => {
    getChapterMock.mockRejectedValue(new Error('boom'));
    renderWithProviders(<StudyChapterEditorPage />, {
      route: '/studies/demo/ch1',
    });
    await waitFor(() =>
      expect(screen.getByTestId('study-editor-error')).toBeInTheDocument(),
    );
  });
});
