import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders, screen } from '../test/test-utils';

/**
 * KS-2893 / ADR-060 §2.5 C5 (FC8). Тесты StudyInviteAcceptPage.
 *
 * Покрытие:
 *  • anon → setAuthReturnUrl(<current>) + navigate('/login');
 *  • auth + preview success → header + name + description + кнопки;
 *  • auth + preview 404 (endpoint не реализован) → graceful fallback,
 *    accept-кнопка активна;
 *  • auth + preview expired/used → error, accept заблокирован;
 *  • accept success → navigate('/studies/<slug>');
 *  • accept error (expired/used/not-found/generic) → inline-error;
 *  • decline → navigate('/studies').
 */

const getPreviewMock = vi.fn();
const acceptMock = vi.fn();
const navigateMock = vi.fn();
const setAuthReturnUrlMock = vi.fn();

vi.mock('../api/studiesApi', () => ({
  studiesApi: {
    getInvitePreview: (...a: unknown[]) => getPreviewMock(...a),
    acceptInvite: (...a: unknown[]) => acceptMock(...a),
  },
}));

const authState: {
  user: { id: string; username: string } | null;
  loading: boolean;
} = { user: { id: 'u1', username: 'tester' }, loading: false };

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ ...authState, token: null }),
}));

const params: { token: string | undefined } = { token: 'tok-1' };
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useLocation: () => ({
      pathname: '/studies/invites/tok-1',
      search: '',
      hash: '',
      state: null,
      key: 'default',
    }),
    useParams: () => params,
  };
});

vi.mock('../utils/authReturnUrl', () => ({
  setAuthReturnUrl: (...a: unknown[]) => setAuthReturnUrlMock(...a),
}));

import { StudyInviteAcceptPage } from './StudyInviteAcceptPage';

beforeEach(() => {
  getPreviewMock.mockReset();
  acceptMock.mockReset();
  navigateMock.mockReset();
  setAuthReturnUrlMock.mockReset();
  authState.user = { id: 'u1', username: 'tester' };
  authState.loading = false;
  params.token = 'tok-1';
  getPreviewMock.mockResolvedValue({
    study: {
      id: 'study-a',
      slug: 'alpha',
      name: 'Alpha study',
      description: 'A nice study',
      ownerUsername: 'OwnerOne',
    },
    expired: false,
    used: false,
  });
  acceptMock.mockResolvedValue({
    study: { id: 'study-a', slug: 'alpha' },
    role: 'contributor',
  });
});

describe('StudyInviteAcceptPage (KS-2893 FC8)', () => {
  it('anon → setAuthReturnUrl + navigate("/login")', async () => {
    authState.user = null;
    renderWithProviders(<StudyInviteAcceptPage />);
    await waitFor(() =>
      expect(setAuthReturnUrlMock).toHaveBeenCalledWith(
        '/studies/invites/tok-1',
      ),
    );
    expect(navigateMock).toHaveBeenCalledWith('/login');
    expect(getPreviewMock).not.toHaveBeenCalled();
  });

  it('auth: preview success → отрисованы имя/описание/owner-link + кнопки', async () => {
    renderWithProviders(<StudyInviteAcceptPage />);
    await waitFor(() => expect(getPreviewMock).toHaveBeenCalledWith('tok-1'));
    expect(
      screen.getByTestId('study-invite-study-name').textContent,
    ).toBe('Alpha study');
    expect(
      screen.getByTestId('study-invite-study-desc').textContent,
    ).toBe('A nice study');
    expect(
      screen.getByTestId('study-invite-study-owner').textContent,
    ).toContain('@OwnerOne');
    expect(screen.getByTestId('study-invite-accept')).toBeInTheDocument();
    expect(screen.getByTestId('study-invite-decline')).toBeInTheDocument();
  });

  it('preview 404 → fallback hint + accept-кнопка активна', async () => {
    getPreviewMock.mockRejectedValueOnce(new Error('Not found'));
    renderWithProviders(<StudyInviteAcceptPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId('study-invite-no-preview'),
      ).toBeInTheDocument(),
    );
    expect(
      (screen.getByTestId('study-invite-accept') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('preview expired → error и accept заблокирован', async () => {
    getPreviewMock.mockResolvedValueOnce({
      study: {
        id: 'study-a',
        slug: 'alpha',
        name: 'Alpha',
        description: null,
        ownerUsername: null,
      },
      expired: true,
      used: false,
    });
    renderWithProviders(<StudyInviteAcceptPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId('study-invite-blocked').textContent,
      ).toMatch(/expired/i),
    );
    expect(
      (screen.getByTestId('study-invite-accept') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('preview used → error и accept заблокирован', async () => {
    getPreviewMock.mockResolvedValueOnce({
      study: {
        id: 'study-a',
        slug: 'alpha',
        name: 'Alpha',
        description: null,
        ownerUsername: null,
      },
      expired: false,
      used: true,
    });
    renderWithProviders(<StudyInviteAcceptPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId('study-invite-blocked').textContent,
      ).toMatch(/already been used/i),
    );
    expect(
      (screen.getByTestId('study-invite-accept') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('accept success → navigate("/studies/<slug>")', async () => {
    renderWithProviders(<StudyInviteAcceptPage />);
    await waitFor(() =>
      expect(screen.getByTestId('study-invite-accept')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('study-invite-accept'));
    await waitFor(() =>
      expect(acceptMock).toHaveBeenCalledWith('tok-1'),
    );
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/studies/alpha'),
    );
  });

  it('accept error «expired» → inline-error с локализованным текстом', async () => {
    acceptMock.mockRejectedValueOnce(new Error('Invite token expired'));
    renderWithProviders(<StudyInviteAcceptPage />);
    await waitFor(() =>
      expect(screen.getByTestId('study-invite-accept')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('study-invite-accept'));
    await waitFor(() =>
      expect(
        screen.getByTestId('study-invite-accept-error').textContent,
      ).toMatch(/expired/i),
    );
    // navigate не вызван — остаёмся на странице.
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('accept error «already used» → нужный текст', async () => {
    acceptMock.mockRejectedValueOnce(new Error('Invite already used'));
    renderWithProviders(<StudyInviteAcceptPage />);
    await waitFor(() =>
      expect(screen.getByTestId('study-invite-accept')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('study-invite-accept'));
    await waitFor(() =>
      expect(
        screen.getByTestId('study-invite-accept-error').textContent,
      ).toMatch(/already been used/i),
    );
  });

  it('accept error «not found» → study deleted message', async () => {
    acceptMock.mockRejectedValueOnce(new Error('Invite not found'));
    renderWithProviders(<StudyInviteAcceptPage />);
    await waitFor(() =>
      expect(screen.getByTestId('study-invite-accept')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('study-invite-accept'));
    await waitFor(() =>
      expect(
        screen.getByTestId('study-invite-accept-error').textContent,
      ).toMatch(/not found|deleted/i),
    );
  });

  it('decline → navigate("/studies")', async () => {
    renderWithProviders(<StudyInviteAcceptPage />);
    await waitFor(() =>
      expect(screen.getByTestId('study-invite-decline')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('study-invite-decline'));
    expect(navigateMock).toHaveBeenCalledWith('/studies');
  });

  it('missing token → error-state с ссылкой на каталог', () => {
    params.token = undefined;
    renderWithProviders(<StudyInviteAcceptPage />);
    expect(
      screen.getByTestId('study-invite-error').textContent,
    ).toMatch(/token/i);
  });
});
