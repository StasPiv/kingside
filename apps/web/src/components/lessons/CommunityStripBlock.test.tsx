import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UserCourseDto } from '@kingside/shared';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { CommunityStripBlock } from './CommunityStripBlock';

/**
 * KS-1923: компактная полоса «New from community» на /lessons.
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
    ownerId: `o-${id}`,
    slug: `slug-${id}`,
    title: `Course ${id}`,
    description: null,
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
      <Route path="/" element={<CommunityStripBlock />} />
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

describe('<CommunityStripBlock>', () => {
  it('fetch с limit=5; рендерит 5 карточек', async () => {
    const list = Array.from({ length: 5 }, (_, i) =>
      mkCourse({ id: `c${i}`, ownerId: `o${i}` }),
    );
    apiMock.listLatest.mockResolvedValueOnce({ data: list });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('community-strip-block')).toBeInTheDocument(),
    );
    expect(apiMock.listLatest).toHaveBeenCalledWith({ limit: 5 });
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  it('view-all link → /lessons/discover', async () => {
    apiMock.listLatest.mockResolvedValueOnce({ data: [mkCourse()] });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('community-strip-block')).toBeInTheDocument(),
    );
    expect(
      screen
        .getByTestId('community-strip-view-all')
        .getAttribute('href'),
    ).toBe('/lessons/discover');
  });

  it('бейдж NEW для курсов <7d', async () => {
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
      expect(screen.getByTestId('community-strip-block')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('community-strip-new-fresh')).toBeInTheDocument();
    expect(screen.queryByTestId('community-strip-new-old')).not.toBeInTheDocument();
  });

  it('фильтрует свои по userId', async () => {
    apiMock.listLatest.mockResolvedValueOnce({
      data: [
        mkCourse({ id: 'a', ownerId: 'me' }),
        mkCourse({ id: 'b', ownerId: 'other' }),
      ],
    });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('community-strip-block')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('community-strip-card-a')).not.toBeInTheDocument();
    expect(screen.getByTestId('community-strip-card-b')).toBeInTheDocument();
  });

  it('пустой список / error → блок скрыт', async () => {
    apiMock.listLatest.mockResolvedValueOnce({ data: [] });
    renderRouter();
    await waitFor(() => expect(apiMock.listLatest).toHaveBeenCalled());
    expect(
      screen.queryByTestId('community-strip-block'),
    ).not.toBeInTheDocument();
  });

  // ─── KS-1924: skeleton + анти-flicker ─────────────────────────────

  it('skeleton не показывается, если данные пришли быстрее 200мс', async () => {
    apiMock.listLatest.mockResolvedValueOnce({ data: [mkCourse()] });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('community-strip-block')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('community-strip-skeleton'),
    ).not.toBeInTheDocument();
  });

  it('skeleton показывается через ~200мс если ответ задерживается', async () => {
    let resolve: (v: { data: import('@kingside/shared').UserCourseDto[] }) => void =
      () => {};
    apiMock.listLatest.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderRouter();
    // Сразу после mount skeleton ещё не успел подняться.
    expect(
      screen.queryByTestId('community-strip-skeleton'),
    ).not.toBeInTheDocument();
    // Дожидаемся подъёма флага (taймer 200мс) — реальный ход времени.
    await waitFor(
      () =>
        expect(
          screen.getByTestId('community-strip-skeleton'),
        ).toBeInTheDocument(),
      { timeout: 800 },
    );
    // После ответа — skeleton уходит, рендерится контент.
    resolve({ data: [mkCourse()] });
    await waitFor(() =>
      expect(screen.getByTestId('community-strip-block')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('community-strip-skeleton'),
    ).not.toBeInTheDocument();
  });
});
