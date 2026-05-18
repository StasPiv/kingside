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

// KS-3014/KS-3015: backend отдаёт `viewerRole` в StudyDto. По умолчанию
// — owner (исторический сценарий тестов). Тесты на viewer/contributor
// переопределяют поле в `getBySlugMock.mockResolvedValueOnce`.
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
  viewerRole: 'owner' as const,
  // KS-2994 / KS-2995: POV-флаг лайка из StudyDto. Дефолт false —
  // owner не лайкнул свою же студию; отдельный тест ниже проверяет
  // likedByMe=true.
  likedByMe: false,
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

  it('owner: видит owner-actions (share/create/import/members/delete)', async () => {
    renderWithProviders(<StudyPage />, { route: '/studies/demo' });
    await waitFor(() =>
      expect(screen.getByTestId('study-owner-actions')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('study-action-share')).toBeInTheDocument();
    expect(screen.getByTestId('study-action-create-chapter')).toBeInTheDocument();
    expect(screen.getByTestId('study-action-import-pgn')).toBeInTheDocument();
    // KS-2892 (FC7): кнопка «Members» доступна только владельцу.
    expect(screen.getByTestId('study-action-members')).toBeInTheDocument();
    expect(screen.getByTestId('study-action-delete')).toBeInTheDocument();
  });

  it('contributor: видит только «+ New chapter» (без share/import/members/delete)', async () => {
    // KS-3014: contributor имеет write-доступ к главам, но не к
    // метаданным студии.
    authState.user = { id: 'u-contrib', username: 'contrib' };
    getBySlugMock.mockResolvedValueOnce({
      study: { ...STUDY, viewerRole: 'contributor' },
      chapters: [],
    });
    renderWithProviders(<StudyPage />, { route: '/studies/demo' });
    await waitFor(() =>
      expect(screen.getByTestId('study-owner-actions')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('study-action-create-chapter')).toBeInTheDocument();
    expect(screen.queryByTestId('study-action-share')).toBeNull();
    expect(screen.queryByTestId('study-action-import-pgn')).toBeNull();
    expect(screen.queryByTestId('study-action-members')).toBeNull();
    expect(screen.queryByTestId('study-action-delete')).toBeNull();
    expect(
      screen.getByTestId('study-page-role-badge').getAttribute('data-viewer-role'),
    ).toBe('contributor');
  });

  it('viewer: owner-actions полностью скрыты, виден badge «Read-only»', async () => {
    authState.user = { id: 'u-viewer', username: 'viewer' };
    getBySlugMock.mockResolvedValueOnce({
      study: { ...STUDY, viewerRole: 'viewer' },
      chapters: [],
    });
    renderWithProviders(<StudyPage />, { route: '/studies/demo' });
    await waitFor(() => expect(getBySlugMock).toHaveBeenCalled());
    expect(screen.queryByTestId('study-owner-actions')).toBeNull();
    expect(screen.queryByTestId('study-action-create-chapter')).toBeNull();
    expect(
      screen.getByTestId('study-page-role-badge').getAttribute('data-viewer-role'),
    ).toBe('viewer');
  });

  it('anon: owner-actions и role-badge не рендерятся вовсе', async () => {
    authState.user = null;
    getBySlugMock.mockResolvedValueOnce({
      study: { ...STUDY, viewerRole: 'anon' },
      chapters: [],
    });
    renderWithProviders(<StudyPage />, { route: '/studies/demo' });
    await waitFor(() => expect(getBySlugMock).toHaveBeenCalled());
    expect(screen.queryByTestId('study-owner-actions')).toBeNull();
    expect(screen.queryByTestId('study-page-role-badge')).toBeNull();
  });

  it('не owner: owner-actions не рендерятся (в т.ч. members)', async () => {
    authState.user = { id: 'other', username: 'other' };
    getBySlugMock.mockResolvedValueOnce({
      study: { ...STUDY, viewerRole: 'viewer' },
      chapters: [],
    });
    renderWithProviders(<StudyPage />, { route: '/studies/demo' });
    await waitFor(() => expect(getBySlugMock).toHaveBeenCalled());
    expect(
      screen.queryByTestId('study-owner-actions'),
    ).not.toBeInTheDocument();
    // KS-2892: явная проверка по testid members-кнопки — регрессия по
    // visibility сразу падает сюда.
    expect(screen.queryByTestId('study-action-members')).toBeNull();
  });

  it('study.likedByMe=true → LikeButton рендерится filled с первого тика', async () => {
    // KS-2995 / ADR-060 §3.4 K4: backend в StudyDto несёт `likedByMe`.
    // StudyPage пробрасывает его в `<LikeButton liked={…}>`, чтобы
    // сердечко не «мигало» из outline в filled на /studies/:slug.
    getBySlugMock.mockResolvedValueOnce({
      study: { ...STUDY, likedByMe: true },
      chapters: [],
    });
    renderWithProviders(<StudyPage />, { route: '/studies/demo' });
    await waitFor(() =>
      expect(screen.getByTestId('study-like-button')).toBeInTheDocument(),
    );
    const btn = screen.getByTestId('study-like-button');
    expect(btn.getAttribute('data-liked')).toBe('true');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('study.likedByMe=false → LikeButton рендерится outline', async () => {
    renderWithProviders(<StudyPage />, { route: '/studies/demo' });
    await waitFor(() =>
      expect(screen.getByTestId('study-like-button')).toBeInTheDocument(),
    );
    const btn = screen.getByTestId('study-like-button');
    expect(btn.getAttribute('data-liked')).toBe('false');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
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
