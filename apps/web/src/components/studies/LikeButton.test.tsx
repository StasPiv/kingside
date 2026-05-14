import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { LikeButton } from './LikeButton';

/**
 * KS-2888 / ADR-060 §3.4 K4 (FC3). Юнит-тесты LikeButton:
 *  - оптимистический инкремент/декремент счётчика;
 *  - синхронизация с server-response (perepisivaem state ответом);
 *  - откат при ошибке;
 *  - anon-клик → setAuthReturnUrl + navigate('/login') без вызова API;
 *  - заблокирована во время pending-запроса.
 */

const toggleLikeMock = vi.fn();
const navigateMock = vi.fn();
const setAuthReturnUrlMock = vi.fn();

// useAuth — переопределяем в каждом тесте через mock.
const authMock = vi.fn();

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => authMock(),
}));

vi.mock('../../api/studiesApi', () => ({
  studiesApi: {
    toggleLike: (...args: unknown[]) => toggleLikeMock(...args),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useLocation: () => ({
      pathname: '/studies/opening-traps',
      search: '?tab=public',
      hash: '',
      state: null,
      key: 'default',
    }),
  };
});

vi.mock('../../utils/authReturnUrl', () => ({
  setAuthReturnUrl: (...args: unknown[]) => setAuthReturnUrlMock(...args),
}));

beforeEach(() => {
  toggleLikeMock.mockReset();
  navigateMock.mockReset();
  setAuthReturnUrlMock.mockReset();
  authMock.mockReset();
  authMock.mockReturnValue({ user: null, token: null, loading: false });
});

function renderBtn(
  override: Partial<React.ComponentProps<typeof LikeButton>> = {},
) {
  return renderWithProviders(
    <LikeButton
      slug="opening-traps"
      studyId="s1"
      likes={10}
      liked={false}
      {...override}
    />,
  );
}

describe('LikeButton (KS-2888 FC3)', () => {
  it('рендерит счётчик и НЕ liked при liked=false', () => {
    renderBtn();
    const btn = screen.getByTestId('study-like-button');
    expect(btn.getAttribute('data-liked')).toBe('false');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(
      screen.getByTestId('study-like-button-count').textContent,
    ).toBe('10');
  });

  it('liked=true → filled-сердечко и aria-pressed=true', () => {
    renderBtn({ liked: true });
    const btn = screen.getByTestId('study-like-button');
    expect(btn.getAttribute('data-liked')).toBe('true');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    const svg = screen.getByTestId('study-like-button-icon');
    expect(svg.getAttribute('fill')).toBe('currentColor');
  });

  it('anon клик → setAuthReturnUrl + navigate("/login"), API не зовётся', () => {
    renderBtn();
    fireEvent.click(screen.getByTestId('study-like-button'));
    expect(setAuthReturnUrlMock).toHaveBeenCalledWith(
      '/studies/opening-traps?tab=public',
    );
    expect(navigateMock).toHaveBeenCalledWith('/login');
    expect(toggleLikeMock).not.toHaveBeenCalled();
  });

  it('user клик → оптимистический инкремент, затем server-truth', async () => {
    authMock.mockReturnValue({
      user: { id: 'u1', username: 'tester' },
      token: 't',
      loading: false,
    });
    // Server вернёт {liked: true, likes: 11} — наш оптимизм должен совпасть.
    toggleLikeMock.mockResolvedValue({ liked: true, likes: 11 });
    const onChange = vi.fn();
    renderBtn({ onChange });
    fireEvent.click(screen.getByTestId('study-like-button'));
    // Оптимистический update — синхронный.
    expect(
      screen.getByTestId('study-like-button-count').textContent,
    ).toBe('11');
    expect(
      screen.getByTestId('study-like-button').getAttribute('data-liked'),
    ).toBe('true');
    expect(toggleLikeMock).toHaveBeenCalledWith('opening-traps');
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith({ liked: true, likes: 11 });
  });

  it('user клик при liked=true → optimistic декремент', async () => {
    authMock.mockReturnValue({
      user: { id: 'u1', username: 'tester' },
      token: 't',
      loading: false,
    });
    toggleLikeMock.mockResolvedValue({ liked: false, likes: 9 });
    renderBtn({ liked: true });
    fireEvent.click(screen.getByTestId('study-like-button'));
    expect(
      screen.getByTestId('study-like-button-count').textContent,
    ).toBe('9');
    expect(
      screen.getByTestId('study-like-button').getAttribute('data-liked'),
    ).toBe('false');
    await waitFor(() => expect(toggleLikeMock).toHaveBeenCalledTimes(1));
  });

  it('ошибка API → откат к prev-значениям, onChange НЕ вызван', async () => {
    authMock.mockReturnValue({
      user: { id: 'u1', username: 'tester' },
      token: 't',
      loading: false,
    });
    toggleLikeMock.mockRejectedValue(new Error('network'));
    const onChange = vi.fn();
    renderBtn({ onChange });
    fireEvent.click(screen.getByTestId('study-like-button'));
    // Оптимизм сразу: 11 / true.
    expect(
      screen.getByTestId('study-like-button-count').textContent,
    ).toBe('11');
    // После reject — откат до 10 / false.
    await waitFor(() =>
      expect(
        screen.getByTestId('study-like-button-count').textContent,
      ).toBe('10'),
    );
    expect(
      screen.getByTestId('study-like-button').getAttribute('data-liked'),
    ).toBe('false');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('повторный клик во время pending игнорируется (disabled)', async () => {
    authMock.mockReturnValue({
      user: { id: 'u1', username: 'tester' },
      token: 't',
      loading: false,
    });
    // Зависнем — нет resolve.
    toggleLikeMock.mockImplementation(() => new Promise(() => {}));
    renderBtn();
    const btn = screen.getByTestId('study-like-button') as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    // Второй клик не вызвал toggleLike повторно.
    expect(toggleLikeMock).toHaveBeenCalledTimes(1);
  });

  it('counter не уходит в минус: liked=true, likes=0 → клик даёт 0', () => {
    authMock.mockReturnValue({
      user: { id: 'u1', username: 'tester' },
      token: 't',
      loading: false,
    });
    toggleLikeMock.mockImplementation(() => new Promise(() => {}));
    renderBtn({ liked: true, likes: 0 });
    fireEvent.click(screen.getByTestId('study-like-button'));
    expect(
      screen.getByTestId('study-like-button-count').textContent,
    ).toBe('0');
  });
});
