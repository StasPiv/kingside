import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderWithProviders, screen, waitFor, userEvent } from '../../test/test-utils';

// KS-2645: переключено на lessonsApi.createCourse.
const { lessonsApiMock, authMock, navigateMock } = vi.hoisted(() => ({
  lessonsApiMock: { createCourse: vi.fn() },
  authMock: {
    user: null as { id: string; username: string } | null,
  },
  navigateMock: vi.fn(),
}));
const apiMock = { create: lessonsApiMock.createCourse };

vi.mock('../../api/lessonsApi', () => ({
  lessonsApi: lessonsApiMock,
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: authMock.user
      ? {
          ...authMock.user,
          email: 'x@x',
          ratingBullet: 1500,
          ratingBlitz: 1500,
          ratingRapid: 1500,
          ratingClassical: 1500,
          createdAt: '2026-01-01',
        }
      : null,
    loading: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

import { CreateCourseCta } from './CreateCourseCta';

beforeEach(() => {
  apiMock.create.mockReset();
  navigateMock.mockReset();
  authMock.user = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<CreateCourseCta>', () => {
  it('гость: компонент не рендерится', () => {
    authMock.user = null;
    renderWithProviders(<CreateCourseCta />);
    expect(screen.queryByTestId('create-course-cta')).toBeNull();
  });

  it('user есть: рендерит кнопку с дефолтным текстом', () => {
    authMock.user = { id: 'u1', username: 'me' };
    renderWithProviders(<CreateCourseCta />);
    const btn = screen.getByTestId('create-course-cta-button');
    expect(btn.textContent).toMatch(/create|создать/i);
    expect(btn.hasAttribute('disabled')).toBe(false);
  });

  it('клик: вызывает create + переход на /lessons/my/<slug>/edit', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    apiMock.create.mockResolvedValueOnce({
      id: 'c1',
      slug: 'new-course',
      ownerId: 'u1',
      title: 'New course',
      description: null,
      isPublic: false,
      createdAt: '2026-04-26',
      updatedAt: '2026-04-26',
      lessonCount: 0,
    });
    renderWithProviders(<CreateCourseCta />);
    await userEvent.setup().click(screen.getByTestId('create-course-cta-button'));
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/lessons/my/new-course/edit'),
    );
  });

  it('ошибка create: показывает сообщение, навигации нет', async () => {
    authMock.user = { id: 'u1', username: 'me' };
    apiMock.create.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<CreateCourseCta />);
    await userEvent.setup().click(screen.getByTestId('create-course-cta-button'));
    await waitFor(() =>
      expect(screen.getByTestId('create-course-cta-error')).toBeInTheDocument(),
    );
    expect(navigateMock).not.toHaveBeenCalled();
    // Кнопка снова доступна.
    expect(
      screen
        .getByTestId('create-course-cta-button')
        .hasAttribute('disabled'),
    ).toBe(false);
  });
});
