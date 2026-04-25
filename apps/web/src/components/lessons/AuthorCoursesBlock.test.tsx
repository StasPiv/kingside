import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UserCourseDto } from '@kingside/shared';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { AuthorCoursesBlock } from './AuthorCoursesBlock';

/**
 * KS-1915: блок «Курсы автора» на странице профиля.
 *
 * Покрытие:
 *  - 3 публичных курса → блок виден, 3 карточки с правильными
 *    ссылками `/lessons/my/<slug>`;
 *  - пустой список → блок скрыт;
 *  - 404/сетевая ошибка → блок скрыт тихо.
 */

vi.mock('../../api', () => ({
  api: {
    get: vi.fn(),
  },
}));

import { api } from '../../api';

const mockedGet = api.get as unknown as ReturnType<typeof vi.fn>;

function mkCourse(over: Partial<UserCourseDto> = {}): UserCourseDto {
  const id = over.id ?? 'c1';
  return {
    id,
    ownerId: 'author-1',
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

function renderWithRouter(username = 'author1') {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<AuthorCoursesBlock username={username} />} />
      <Route
        path="/lessons/my/:slug"
        element={<div data-testid="course-page" />}
      />
    </Routes>,
    { route: '/' },
  );
}

beforeEach(() => {
  mockedGet.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<AuthorCoursesBlock>', () => {
  it('профиль с 3 публичными курсами → блок виден, 3 карточки', async () => {
    mockedGet.mockResolvedValueOnce({
      data: [
        mkCourse({ id: 'a', title: 'A', slug: 'slug-a' }),
        mkCourse({ id: 'b', title: 'B', slug: 'slug-b' }),
        mkCourse({ id: 'c', title: 'C', slug: 'slug-c' }),
      ],
    });
    renderWithRouter('john');

    await waitFor(() =>
      expect(screen.getByTestId('author-courses-block')).toBeInTheDocument(),
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByTestId('author-courses-card-a')).toBeInTheDocument();
    expect(screen.getByTestId('author-courses-card-b')).toBeInTheDocument();
    expect(screen.getByTestId('author-courses-card-c')).toBeInTheDocument();

    expect(mockedGet).toHaveBeenCalledWith('/players/john/courses');
  });

  it('username с спецсимволами URL-енкодится', async () => {
    mockedGet.mockResolvedValueOnce({ data: [] });
    renderWithRouter('a/b user');
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(mockedGet).toHaveBeenCalledWith('/players/a%2Fb%20user/courses');
  });

  it('пустой список → блок скрыт', async () => {
    mockedGet.mockResolvedValueOnce({ data: [] });
    renderWithRouter('jane');
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(
      screen.queryByTestId('author-courses-block'),
    ).not.toBeInTheDocument();
  });

  it('404 (несуществующий username) → блок скрыт тихо', async () => {
    mockedGet.mockRejectedValueOnce(new Error('Resource not found'));
    renderWithRouter('ghost');
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(
      screen.queryByTestId('author-courses-block'),
    ).not.toBeInTheDocument();
  });

  it('карточка содержит правильную ссылку /lessons/my/<slug>', async () => {
    mockedGet.mockResolvedValueOnce({
      data: [mkCourse({ id: 'x', slug: 'my-course' })],
    });
    renderWithRouter('john');
    await waitFor(() =>
      expect(screen.getByTestId('author-courses-block')).toBeInTheDocument(),
    );
    const link = screen.getByTestId('author-courses-link-x');
    expect(link.getAttribute('href')).toBe('/lessons/my/my-course');
  });

  it('lessonCount показывается (через lessons.my.lessonsCount plural)', async () => {
    mockedGet.mockResolvedValueOnce({
      data: [mkCourse({ id: 'a', lessonCount: 5 })],
    });
    renderWithRouter('john');
    await waitFor(() =>
      expect(screen.getByTestId('author-courses-block')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('author-courses-card-a').textContent,
    ).toMatch(/5/);
  });
});
