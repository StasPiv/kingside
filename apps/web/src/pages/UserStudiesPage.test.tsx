import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders, screen } from '../test/test-utils';

/**
 * KS-2889 / ADR-060 §3.4 K6 (FC4). Тесты UserStudiesPage:
 *  - anon: fetch без includePrivate, toggle не виден;
 *  - owner: toggle виден, клик добавляет ?includePrivate=1 в URL и
 *    запрос дёргается с includePrivate=true;
 *  - title рендерится из owner.username из ответа;
 *  - empty / error / sentinel при hasMore.
 */

const listByUserMock = vi.fn();
vi.mock('../api/studiesApi', () => ({
  studiesApi: {
    listByUser: (userId: string, opts: unknown) =>
      listByUserMock(userId, opts),
    toggleLike: vi.fn(),
  },
}));

const authState: { user: { id: string; username: string } | null } = {
  user: null,
};
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user, token: null, loading: false }),
}));

// Параметры маршрута и query прокидываем через мок react-router-dom,
// чтобы не разворачивать настоящий <Routes path="/studies/by/:userId">.
// useSearchParams моделируем через React.useState — иначе setSearchParams
// в обработчике toggle не вызовет ререндер.
const routeState: { userId: string; initialQuery: URLSearchParams } = {
  userId: 'u-author',
  initialQuery: new URLSearchParams(),
};
const setSearchParamsImpl = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useParams: () => ({ userId: routeState.userId }),
    useSearchParams: () => {
      const [params, setParams] = React.useState<URLSearchParams>(
        () => new URLSearchParams(routeState.initialQuery),
      );
      const setter = React.useCallback(
        (
          updater:
            | URLSearchParams
            | ((prev: URLSearchParams) => URLSearchParams),
        ) => {
          setParams((prev) => {
            const next =
              typeof updater === 'function' ? updater(prev) : updater;
            const result = new URLSearchParams(next);
            setSearchParamsImpl(result);
            return result;
          });
        },
        [],
      );
      return [params, setter] as const;
    },
  };
});

class FakeIO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
  FakeIO;

import { UserStudiesPage } from './UserStudiesPage';

const OWNER = { id: 'u-author', username: 'AuthorJoe' };

const PUBLIC_STUDY = {
  id: 'p1',
  ownerId: OWNER.id,
  slug: 'opening-traps',
  name: 'Opening traps',
  description: 'Sharp lines',
  isPublic: true,
  visibility: 'public',
  topics: ['openings'],
  likes: 5,
  fromKind: 'scratch',
  fromRefId: null,
  chaptersCount: 3,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-02T00:00:00.000Z',
};
const PRIVATE_STUDY = {
  ...PUBLIC_STUDY,
  id: 'p2',
  slug: 'wip-notes',
  name: 'WIP notes',
  isPublic: false,
  visibility: 'private',
};

beforeEach(() => {
  listByUserMock.mockReset();
  setSearchParamsImpl.mockClear();
  listByUserMock.mockResolvedValue({
    items: [PUBLIC_STUDY],
    total: 1,
    hasMore: false,
    owner: OWNER,
  });
  authState.user = null;
  routeState.userId = 'u-author';
  routeState.initialQuery = new URLSearchParams();
});

describe('UserStudiesPage (KS-2889 FC4)', () => {
  it('anon: fetch без includePrivate, toggle не виден, видны public-студии', async () => {
    renderWithProviders(<UserStudiesPage />);
    await waitFor(() => expect(listByUserMock).toHaveBeenCalled());
    expect(listByUserMock).toHaveBeenCalledWith(
      'u-author',
      // KS-3011 hotfix: 1-based pagination.
      expect.objectContaining({ includePrivate: false, page: 1 }),
    );
    expect(
      screen.queryByTestId('user-studies-include-private'),
    ).not.toBeInTheDocument();
    expect(screen.getAllByTestId('study-catalog-card')).toHaveLength(1);
    expect(screen.getByTestId('user-studies-title').textContent).toContain(
      'AuthorJoe',
    );
  });

  it('owner: toggle виден, клик добавляет ?includePrivate=1 и пере-fetch', async () => {
    routeState.userId = OWNER.id;
    authState.user = { id: OWNER.id, username: OWNER.username };
    listByUserMock
      .mockResolvedValueOnce({
        items: [PUBLIC_STUDY],
        total: 1,
        hasMore: false,
        owner: OWNER,
      })
      .mockResolvedValueOnce({
        items: [PUBLIC_STUDY, PRIVATE_STUDY],
        total: 2,
        hasMore: false,
        owner: OWNER,
      });
    renderWithProviders(<UserStudiesPage />);
    await waitFor(() => expect(listByUserMock).toHaveBeenCalledTimes(1));
    expect(listByUserMock).toHaveBeenLastCalledWith(
      OWNER.id,
      expect.objectContaining({ includePrivate: false }),
    );
    const toggle = await screen.findByTestId(
      'user-studies-include-private-input',
    );
    fireEvent.click(toggle);
    // setSearchParamsImpl мокаемый — сам обновляет routeState.query,
    // что вызывает повторный effect и fetch.
    await waitFor(() => expect(listByUserMock).toHaveBeenCalledTimes(2));
    expect(listByUserMock).toHaveBeenLastCalledWith(
      OWNER.id,
      expect.objectContaining({ includePrivate: true }),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('study-catalog-card')).toHaveLength(2),
    );
  });

  it('owner: title — «My studies» (а не username)', async () => {
    routeState.userId = OWNER.id;
    authState.user = { id: OWNER.id, username: OWNER.username };
    renderWithProviders(<UserStudiesPage />);
    await waitFor(() => expect(listByUserMock).toHaveBeenCalled());
    expect(screen.getByTestId('user-studies-title').textContent).toBe(
      'My studies',
    );
  });

  it('?includePrivate=1 в URL — toggle pre-checked и fetch с includePrivate=true', async () => {
    routeState.userId = OWNER.id;
    routeState.initialQuery = new URLSearchParams('includePrivate=1');
    authState.user = { id: OWNER.id, username: OWNER.username };
    renderWithProviders(<UserStudiesPage />);
    await waitFor(() => expect(listByUserMock).toHaveBeenCalled());
    expect(listByUserMock).toHaveBeenLastCalledWith(
      OWNER.id,
      expect.objectContaining({ includePrivate: true }),
    );
    const toggle = screen.getByTestId(
      'user-studies-include-private-input',
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it('anon с ?includePrivate=1: backend всё равно зовётся БЕЗ флага (не owner)', async () => {
    routeState.initialQuery = new URLSearchParams('includePrivate=1');
    renderWithProviders(<UserStudiesPage />);
    await waitFor(() => expect(listByUserMock).toHaveBeenCalled());
    expect(listByUserMock).toHaveBeenLastCalledWith(
      'u-author',
      expect.objectContaining({ includePrivate: false }),
    );
  });

  it('пустой ответ → empty-state', async () => {
    listByUserMock.mockResolvedValueOnce({
      items: [],
      total: 0,
      hasMore: false,
      owner: OWNER,
    });
    renderWithProviders(<UserStudiesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('user-studies-empty')).toBeInTheDocument(),
    );
  });

  it('ошибка → error-state', async () => {
    listByUserMock.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<UserStudiesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('user-studies-error')).toBeInTheDocument(),
    );
  });

  it('hasMore=true → sentinel в DOM', async () => {
    listByUserMock.mockResolvedValueOnce({
      items: [PUBLIC_STUDY],
      total: 25,
      hasMore: true,
      owner: OWNER,
    });
    renderWithProviders(<UserStudiesPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId('user-studies-load-more-sentinel'),
      ).toBeInTheDocument(),
    );
  });
});
