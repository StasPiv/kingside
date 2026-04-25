import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CourseAuthorDto } from '@kingside/shared';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { CourseAuthorsBlock } from './CourseAuthorsBlock';

/**
 * KS-1919: блок «Course authors» на /lessons.
 */

const { apiMock } = vi.hoisted(() => ({
  apiMock: { listAuthors: vi.fn() },
}));

vi.mock('../../api/userCoursesApi', () => ({
  userCoursesApi: apiMock,
}));

function mkAuthor(over: Partial<CourseAuthorDto> = {}): CourseAuthorDto {
  const id = over.user?.id ?? 'u1';
  return {
    user: {
      id,
      username: `user-${id}`,
      ...(over.user ?? {}),
    },
    publicCoursesCount: 1,
    lastCourseUpdatedAt: '2026-04-20T10:00:00Z',
    latestCourseSlug: `slug-${id}`,
    latestCourseTitle: `Latest by ${id}`,
    ...over,
    user: {
      id,
      username: over.user?.username ?? `user-${id}`,
      displayName: over.user?.displayName,
      avatarUrl: over.user?.avatarUrl,
    },
  };
}

function renderRouter() {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<CourseAuthorsBlock />} />
    </Routes>,
    { route: '/' },
  );
}

beforeEach(() => {
  apiMock.listAuthors.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<CourseAuthorsBlock>', () => {
  it('fetch listAuthors({sort:courses, limit:12}); рендерит 12 карточек', async () => {
    const list = Array.from({ length: 12 }, (_, i) =>
      mkAuthor({
        user: { id: `u${i}`, username: `u${i}` },
        publicCoursesCount: 12 - i,
      }),
    );
    apiMock.listAuthors.mockResolvedValueOnce({ data: list, total: 12 });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('course-authors-block')).toBeInTheDocument(),
    );
    expect(apiMock.listAuthors).toHaveBeenCalledWith({
      sort: 'courses',
      limit: 12,
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
  });

  it('teaser ведёт на /lessons/my/<latestCourseSlug>', async () => {
    apiMock.listAuthors.mockResolvedValueOnce({
      data: [
        mkAuthor({
          user: { id: 'u1', username: 'alice' },
          latestCourseSlug: 'caro-kann-101',
          latestCourseTitle: 'Caro-Kann 101',
        }),
      ],
      total: 1,
    });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('course-authors-block')).toBeInTheDocument(),
    );
    const teaser = screen.getByTestId('course-authors-teaser-u1');
    expect(teaser.getAttribute('href')).toBe('/lessons/my/caro-kann-101');
    expect(teaser.textContent).toMatch(/Caro-Kann 101/);
  });

  it('username link → /player/<username>', async () => {
    apiMock.listAuthors.mockResolvedValueOnce({
      data: [
        mkAuthor({ user: { id: 'u1', username: 'alice bob' } }),
      ],
      total: 1,
    });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('course-authors-block')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('course-authors-link-u1').getAttribute('href'),
    ).toBe('/player/alice%20bob');
  });

  it('кнопка «All authors» ведёт на /players?tab=authors', async () => {
    apiMock.listAuthors.mockResolvedValueOnce({
      data: [mkAuthor()],
      total: 1,
    });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('course-authors-block')).toBeInTheDocument(),
    );
    const link = screen.getByTestId('course-authors-all-link');
    expect(link.getAttribute('href')).toBe('/players?tab=authors');
  });

  it('пустой список → блок скрыт', async () => {
    apiMock.listAuthors.mockResolvedValueOnce({ data: [], total: 0 });
    renderRouter();
    await waitFor(() => expect(apiMock.listAuthors).toHaveBeenCalled());
    expect(
      screen.queryByTestId('course-authors-block'),
    ).not.toBeInTheDocument();
  });

  it('error → блок скрыт тихо', async () => {
    apiMock.listAuthors.mockRejectedValueOnce(new Error('boom'));
    renderRouter();
    await waitFor(() => expect(apiMock.listAuthors).toHaveBeenCalled());
    expect(
      screen.queryByTestId('course-authors-block'),
    ).not.toBeInTheDocument();
  });
});
