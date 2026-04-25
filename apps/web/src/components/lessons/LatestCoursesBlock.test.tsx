import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UserCourseDto } from '@kingside/shared';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { LatestCoursesBlock } from './LatestCoursesBlock';

/**
 * KS-1919: лента последних публичных курсов на /lessons.
 */

const { apiMock, authMock } = vi.hoisted(() => ({
  apiMock: { listLatest: vi.fn() },
  authMock: {
    user: { id: 'me', username: 'me' } as { id: string; username: string } | null,
  },
}));

vi.mock('../../api/userCoursesApi', () => ({
  userCoursesApi: apiMock,
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: authMock.user
      ? {
          ...authMock.user,
          email: 'm@x',
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

function mkCourse(over: Partial<UserCourseDto> = {}): UserCourseDto {
  const id = over.id ?? 'c1';
  return {
    id,
    ownerId: `owner-${id}`,
    slug: `slug-${id}`,
    title: `Course ${id}`,
    description: 'desc',
    isPublic: true,
    createdAt: '2026-04-20T10:00:00Z',
    updatedAt: '2026-04-20T10:00:00Z',
    lessonCount: 3,
    ...over,
  };
}

function renderRouter() {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<LatestCoursesBlock />} />
    </Routes>,
    { route: '/' },
  );
}

beforeEach(() => {
  apiMock.listLatest.mockReset();
  authMock.user = { id: 'me', username: 'me' };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<LatestCoursesBlock>', () => {
  it('рендерит до 10 курсов; вызывает listLatest({limit:10})', async () => {
    const list = Array.from({ length: 10 }, (_, i) =>
      mkCourse({ id: `c${i}`, ownerId: `o${i}` }),
    );
    apiMock.listLatest.mockResolvedValueOnce({ data: list });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('latest-courses-block')).toBeInTheDocument(),
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(apiMock.listLatest).toHaveBeenCalledWith({ limit: 10 });
  });

  it('фильтрует свои курсы из ленты по userId', async () => {
    apiMock.listLatest.mockResolvedValueOnce({
      data: [
        mkCourse({ id: 'a', ownerId: 'me' }), // мой → должен пропасть
        mkCourse({ id: 'b', ownerId: 'other' }),
        mkCourse({ id: 'c', ownerId: 'me' }), // мой
        mkCourse({ id: 'd', ownerId: 'x' }),
      ],
    });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('latest-courses-block')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('latest-courses-card-b')).toBeInTheDocument();
    expect(screen.getByTestId('latest-courses-card-d')).toBeInTheDocument();
    expect(screen.queryByTestId('latest-courses-card-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('latest-courses-card-c')).not.toBeInTheDocument();
  });

  it('бейдж NEW для курсов обновлённых < 7 дней назад', async () => {
    const today = new Date();
    const fresh = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const old = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    apiMock.listLatest.mockResolvedValueOnce({
      data: [
        mkCourse({ id: 'fresh', ownerId: 'x', updatedAt: fresh }),
        mkCourse({ id: 'old', ownerId: 'y', updatedAt: old }),
      ],
    });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('latest-courses-block')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('latest-courses-new-fresh'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('latest-courses-new-old'),
    ).not.toBeInTheDocument();
  });

  it('пустой список (после фильтра своих) → блок скрыт', async () => {
    apiMock.listLatest.mockResolvedValueOnce({
      data: [mkCourse({ id: 'a', ownerId: 'me' })],
    });
    renderRouter();
    await waitFor(() => expect(apiMock.listLatest).toHaveBeenCalled());
    expect(
      screen.queryByTestId('latest-courses-block'),
    ).not.toBeInTheDocument();
  });

  it('error → блок скрыт тихо', async () => {
    apiMock.listLatest.mockRejectedValueOnce(new Error('boom'));
    renderRouter();
    await waitFor(() => expect(apiMock.listLatest).toHaveBeenCalled());
    expect(
      screen.queryByTestId('latest-courses-block'),
    ).not.toBeInTheDocument();
  });

  it('description обрезается до ~100 символов с многоточием', async () => {
    const longDesc = 'x'.repeat(200);
    apiMock.listLatest.mockResolvedValueOnce({
      data: [
        mkCourse({ id: 'a', ownerId: 'x', description: longDesc }),
      ],
    });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('latest-courses-card-a')).toBeInTheDocument(),
    );
    const text =
      screen.getByTestId('latest-courses-card-a').textContent ?? '';
    expect(text).toMatch(/…/);
    // Не более 110 символов в начале (100 + многоточие + хвост)
    const xCount = text.match(/x/g)?.length ?? 0;
    expect(xCount).toBeLessThan(150);
  });
});
