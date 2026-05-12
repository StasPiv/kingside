import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor, fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../test/test-utils';

/**
 * KS-2826 (KS-2815 §B.5): smoke-тесты `StudyPage`.
 */

const getBySlugMock = vi.fn();
const shareMock = vi.fn();
const createChapterMock = vi.fn();
const deleteMock = vi.fn();
vi.mock('../api/studiesApi', () => ({
  studiesApi: {
    getBySlug: (slug: string) => getBySlugMock(slug),
    share: (slug: string, pub: boolean) => shareMock(slug, pub),
    createChapter: (slug: string, req: unknown) => createChapterMock(slug, req),
    delete: (slug: string) => deleteMock(slug),
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
    useParams: () => ({ slug: 'demo' }),
    useNavigate: () => navigateMock,
  };
});

import { StudyPage } from './StudyPage';

const STUDY = {
  id: 's1',
  ownerId: 'u1',
  slug: 'demo',
  name: 'Demo study',
  description: 'A test',
  isPublic: false,
  chaptersCount: 2,
  createdAt: '2026-05-12T10:00:00.000Z',
  updatedAt: '2026-05-12T10:00:00.000Z',
};

beforeEach(() => {
  getBySlugMock.mockReset();
  shareMock.mockReset();
  createChapterMock.mockReset();
  deleteMock.mockReset();
  navigateMock.mockReset();
  getBySlugMock.mockResolvedValue({
    study: STUDY,
    chapters: [
      {
        id: 'ch1',
        name: 'Chapter 1',
        orderIdx: 1,
        startFen: null,
        orientation: 'white',
        mode: 'analysis',
        createdAt: '2026-05-12T10:00:00.000Z',
        updatedAt: '2026-05-12T10:00:00.000Z',
      },
      {
        id: 'ch2',
        name: 'Chapter 2',
        orderIdx: 2,
        startFen: null,
        orientation: 'white',
        mode: 'analysis',
        createdAt: '2026-05-12T10:00:00.000Z',
        updatedAt: '2026-05-12T10:00:00.000Z',
      },
    ],
  });
  authState.user = { id: 'u1', username: 'tester' };
});

describe('StudyPage (KS-2826)', () => {
  it('загружает студию и рендерит главы', async () => {
    renderWithProviders(<StudyPage />, { route: '/studies/demo' });
    await waitFor(() => expect(getBySlugMock).toHaveBeenCalledWith('demo'));
    expect(screen.getByTestId('study-page-name')).toHaveTextContent('Demo study');
    expect(screen.getByTestId('study-page-badge')).toHaveTextContent(/private/i);
    expect(screen.getByTestId('study-chapter-ch1')).toBeInTheDocument();
    expect(screen.getByTestId('study-chapter-ch2')).toBeInTheDocument();
  });

  it('owner: видит owner-actions (share/create/import/delete)', async () => {
    renderWithProviders(<StudyPage />, { route: '/studies/demo' });
    await waitFor(() =>
      expect(screen.getByTestId('study-owner-actions')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('study-action-share')).toBeInTheDocument();
    expect(screen.getByTestId('study-action-create-chapter')).toBeInTheDocument();
    expect(screen.getByTestId('study-action-import-pgn')).toBeInTheDocument();
    expect(screen.getByTestId('study-action-delete')).toBeInTheDocument();
  });

  it('не owner: owner-actions не рендерятся', async () => {
    authState.user = { id: 'other', username: 'other' };
    renderWithProviders(<StudyPage />, { route: '/studies/demo' });
    await waitFor(() => expect(getBySlugMock).toHaveBeenCalled());
    expect(
      screen.queryByTestId('study-owner-actions'),
    ).not.toBeInTheDocument();
  });

  it('click share → studiesApi.share(slug, !isPublic), обновляет badge', async () => {
    shareMock.mockResolvedValue({ ...STUDY, isPublic: true });
    renderWithProviders(<StudyPage />, { route: '/studies/demo' });
    await waitFor(() =>
      expect(screen.getByTestId('study-action-share')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('study-action-share'));
    await waitFor(() => expect(shareMock).toHaveBeenCalledWith('demo', true));
    await waitFor(() =>
      expect(screen.getByTestId('study-page-badge')).toHaveTextContent(/public/i),
    );
  });

  it('click create chapter → создаёт и navigate в editor', async () => {
    createChapterMock.mockResolvedValue({ id: 'ch-new' });
    renderWithProviders(<StudyPage />, { route: '/studies/demo' });
    await waitFor(() =>
      expect(
        screen.getByTestId('study-action-create-chapter'),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('study-action-create-chapter'));
    await waitFor(() =>
      expect(createChapterMock).toHaveBeenCalledWith('demo', expect.any(Object)),
    );
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/studies/demo/ch-new'),
    );
  });

  it('click delete (after confirm) → studiesApi.delete + navigate /studies?tab=mine', async () => {
    // jsdom не реализует window.confirm — присваиваем mock напрямую.
    const orig = window.confirm;
    window.confirm = vi.fn(() => true) as typeof window.confirm;
    deleteMock.mockResolvedValue(undefined);
    renderWithProviders(<StudyPage />, { route: '/studies/demo' });
    await waitFor(() =>
      expect(screen.getByTestId('study-action-delete')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('study-action-delete'));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('demo'));
    expect(navigateMock).toHaveBeenCalledWith('/studies?tab=mine', {
      replace: true,
    });
    window.confirm = orig;
  });

  it('confirm=false → delete не вызывается', async () => {
    const orig = window.confirm;
    window.confirm = vi.fn(() => false) as typeof window.confirm;
    renderWithProviders(<StudyPage />, { route: '/studies/demo' });
    await waitFor(() =>
      expect(screen.getByTestId('study-action-delete')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('study-action-delete'));
    expect(deleteMock).not.toHaveBeenCalled();
    window.confirm = orig;
  });

  it('пустой список глав → empty-стейт (owner вариант)', async () => {
    getBySlugMock.mockResolvedValue({ study: STUDY, chapters: [] });
    renderWithProviders(<StudyPage />, { route: '/studies/demo' });
    await waitFor(() =>
      expect(screen.getByTestId('study-chapters-empty')).toBeInTheDocument(),
    );
  });

  it('ошибка getBySlug → error-стейт', async () => {
    getBySlugMock.mockRejectedValue(new Error('boom'));
    renderWithProviders(<StudyPage />, { route: '/studies/demo' });
    await waitFor(() =>
      expect(screen.getByTestId('study-error')).toBeInTheDocument(),
    );
  });
});
