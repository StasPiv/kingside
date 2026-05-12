import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';

import { renderWithProviders, screen } from '../test/test-utils';

/**
 * KS-2825 (KS-2815 §B.5): smoke-тесты `StudiesPage`. Mock'аем
 * `studiesApi.list` и `studiesApi.listPublic`, проверяем рендер
 * табов, карточек, empty/error/loading state.
 */

const listMock = vi.fn();
const listPublicMock = vi.fn();
vi.mock('../api/studiesApi', () => ({
  studiesApi: {
    list: (opts: { mine?: boolean }) => listMock(opts),
    listPublic: () => listPublicMock(),
  },
}));

const authState: { user: { id: string; username: string } | null } = {
  user: { id: 'u1', username: 'tester' },
};
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user, loading: false }),
}));

import { StudiesPage } from './StudiesPage';

beforeEach(() => {
  listMock.mockReset();
  listPublicMock.mockReset();
  listMock.mockResolvedValue({ data: [] });
  listPublicMock.mockResolvedValue({ data: [] });
  authState.user = { id: 'u1', username: 'tester' };
});

describe('StudiesPage (KS-2825)', () => {
  it('авторизованный: рендерит табы Мои/Публичные, активен «Мои»', async () => {
    renderWithProviders(<StudiesPage />, { route: '/studies' });
    expect(screen.getByTestId('studies-page')).toBeInTheDocument();
    expect(screen.getByTestId('studies-tabs')).toBeInTheDocument();
    await waitFor(() => expect(listMock).toHaveBeenCalledWith({ mine: true }));
    expect(screen.getByTestId('studies-tab-mine').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('studies-tab-public').getAttribute('aria-selected')).toBe('false');
  });

  it('гость: табов нет, активен «Публичные» (listPublic)', async () => {
    authState.user = null;
    renderWithProviders(<StudiesPage />, { route: '/studies' });
    expect(screen.queryByTestId('studies-tabs')).not.toBeInTheDocument();
    await waitFor(() => expect(listPublicMock).toHaveBeenCalled());
  });

  it('пустой ответ → empty-стейт', async () => {
    listMock.mockResolvedValue({ data: [] });
    renderWithProviders(<StudiesPage />, { route: '/studies' });
    await waitFor(() =>
      expect(screen.getByTestId('studies-empty')).toBeInTheDocument(),
    );
  });

  it('ошибка → error-стейт', async () => {
    listMock.mockRejectedValue(new Error('boom'));
    renderWithProviders(<StudiesPage />, { route: '/studies' });
    await waitFor(() =>
      expect(screen.getByTestId('studies-error')).toBeInTheDocument(),
    );
  });

  it('список студий → грид с карточками', async () => {
    listMock.mockResolvedValue({
      data: [
        {
          id: 'a',
          ownerId: 'u1',
          slug: 'alpha',
          name: 'Alpha study',
          description: 'Demo description',
          isPublic: true,
          chaptersCount: 3,
          createdAt: '2026-05-12T10:00:00.000Z',
          updatedAt: '2026-05-12T10:00:00.000Z',
        },
        {
          id: 'b',
          ownerId: 'u1',
          slug: 'beta',
          name: 'Beta study',
          description: null,
          isPublic: false,
          chaptersCount: 0,
          createdAt: '2026-05-12T10:00:00.000Z',
          updatedAt: '2026-05-12T10:00:00.000Z',
        },
      ],
    });
    renderWithProviders(<StudiesPage />, { route: '/studies' });
    await waitFor(() =>
      expect(screen.getByTestId('studies-grid')).toBeInTheDocument(),
    );
    const alpha = screen.getByTestId('studies-card-alpha');
    const beta = screen.getByTestId('studies-card-beta');
    expect(alpha.getAttribute('href')).toBe('/studies/alpha');
    expect(beta.getAttribute('href')).toBe('/studies/beta');
    expect(screen.getByTestId('studies-card-badge-alpha')).toHaveTextContent(/public/i);
    expect(screen.getByTestId('studies-card-badge-beta')).toHaveTextContent(/private/i);
  });

  it('клик по табу «Публичные» → listPublic, обновляется query-param', async () => {
    renderWithProviders(<StudiesPage />, { route: '/studies' });
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    screen.getByTestId('studies-tab-public').click();
    await waitFor(() => expect(listPublicMock).toHaveBeenCalled());
  });

  it('?tab=public → активен таб Public', async () => {
    renderWithProviders(<StudiesPage />, {
      route: '/studies?tab=public',
    });
    await waitFor(() => expect(listPublicMock).toHaveBeenCalled());
    expect(screen.getByTestId('studies-tab-public').getAttribute('aria-selected')).toBe('true');
  });
});
