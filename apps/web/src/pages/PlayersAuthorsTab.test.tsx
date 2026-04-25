import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { CourseAuthorDto } from '@kingside/shared';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { PlayersAuthorsTab } from './PlayersAuthorsTab';

/**
 * KS-1920: четвёртый таб «Authors» на /players с infinite scroll
 * и sort-toggle.
 */

const { apiMock } = vi.hoisted(() => ({
  apiMock: { listAuthors: vi.fn() },
}));

vi.mock('../api/userCoursesApi', () => ({
  userCoursesApi: apiMock,
}));

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  target: Element | null = null;
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb;
    MockIntersectionObserver.instances.push(this);
  }
  observe(node: Element) {
    this.target = node;
  }
  disconnect() {
    this.target = null;
  }
  unobserve() {
    /* noop */
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  root = null;
  rootMargin = '';
  thresholds = [];
  trigger() {
    if (!this.target) return;
    this.callback(
      [{ isIntersecting: true, target: this.target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function mkAuthor(over: Partial<CourseAuthorDto> = {}): CourseAuthorDto {
  const id = over.user?.id ?? 'u1';
  return {
    user: {
      id,
      username: `user-${id}`,
      displayName: over.user?.displayName,
      avatarUrl: over.user?.avatarUrl,
    },
    publicCoursesCount: 5,
    lastCourseUpdatedAt: '2026-04-20T10:00:00Z',
    latestCourseSlug: `slug-${id}`,
    latestCourseTitle: 'Latest',
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
      <Route path="/" element={<PlayersAuthorsTab />} />
    </Routes>,
    { route: '/' },
  );
}

beforeEach(() => {
  apiMock.listAuthors.mockReset();
  MockIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('<PlayersAuthorsTab>', () => {
  it('первая загрузка вызывает listAuthors({sort:courses, limit:50, offset:0})', async () => {
    apiMock.listAuthors.mockResolvedValueOnce({ data: [], total: 0 });
    renderRouter();
    await waitFor(() => expect(apiMock.listAuthors).toHaveBeenCalled());
    expect(apiMock.listAuthors).toHaveBeenCalledWith({
      sort: 'courses',
      limit: 50,
      offset: 0,
    });
  });

  it('переключение на «Recently updated» → listAuthors({sort:recent, ...})', async () => {
    apiMock.listAuthors.mockResolvedValue({ data: [], total: 0 });
    renderRouter();
    await waitFor(() => expect(apiMock.listAuthors).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('players-authors-sort-recent'));
    await waitFor(() =>
      expect(apiMock.listAuthors).toHaveBeenCalledTimes(2),
    );
    expect(apiMock.listAuthors).toHaveBeenLastCalledWith({
      sort: 'recent',
      limit: 50,
      offset: 0,
    });
  });

  it('infinite scroll: при IntersectionObserver hit → второй fetch с offset=данные.length', async () => {
    apiMock.listAuthors.mockResolvedValueOnce({
      data: Array.from({ length: 50 }, (_, i) =>
        mkAuthor({ user: { id: `u${i}`, username: `u${i}` } }),
      ),
      total: 120,
    });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('players-authors-tab')).toBeInTheDocument(),
    );
    // Дожидаемся пока IntersectionObserver реально создан
    // (после loading=false и появления sentinel в DOM).
    await waitFor(() => {
      expect(screen.getByTestId('players-authors-sentinel')).toBeInTheDocument();
      expect(MockIntersectionObserver.instances.length).toBeGreaterThan(0);
    });

    // Готовим второй fetch
    apiMock.listAuthors.mockResolvedValueOnce({
      data: Array.from({ length: 50 }, (_, i) =>
        mkAuthor({ user: { id: `u${50 + i}`, username: `u${50 + i}` } }),
      ),
      total: 120,
    });

    // Триггерим последний созданный observer
    const observer = MockIntersectionObserver.instances.at(-1)!;
    observer.trigger();

    await waitFor(() =>
      expect(apiMock.listAuthors).toHaveBeenCalledTimes(2),
    );
    expect(apiMock.listAuthors).toHaveBeenLastCalledWith({
      sort: 'courses',
      limit: 50,
      offset: 50,
    });
  });

  it('пустой список → empty-state', async () => {
    apiMock.listAuthors.mockResolvedValueOnce({ data: [], total: 0 });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('players-authors-empty')).toBeInTheDocument(),
    );
  });

  it('ошибка → error-state со «Try again»', async () => {
    apiMock.listAuthors.mockRejectedValueOnce(new Error('boom'));
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('players-authors-error')).toBeInTheDocument(),
    );
    // Retry
    apiMock.listAuthors.mockResolvedValueOnce({ data: [], total: 0 });
    fireEvent.click(screen.getByText(/Try again/i));
    await waitFor(() =>
      expect(apiMock.listAuthors).toHaveBeenCalledTimes(2),
    );
  });

  it('клик по строке автора ведёт на /player/<username>', async () => {
    apiMock.listAuthors.mockResolvedValueOnce({
      data: [mkAuthor({ user: { id: 'a1', username: 'alice' } })],
      total: 1,
    });
    renderRouter();
    await waitFor(() =>
      expect(screen.getByTestId('players-authors-row-a1')).toBeInTheDocument(),
    );
    const link = screen.getByTestId('players-authors-link-a1');
    expect(link.getAttribute('href')).toBe('/player/alice');
  });
});
