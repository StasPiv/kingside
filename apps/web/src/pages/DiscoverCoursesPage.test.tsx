import { describe, it, expect, vi } from 'vitest';

import { renderWithProviders, screen } from '../test/test-utils';
import { DiscoverCoursesPage } from './DiscoverCoursesPage';

/**
 * KS-1923: smoke на /lessons/discover.
 */

vi.mock('../components/lessons/LatestCoursesBlock', () => ({
  LatestCoursesBlock: () => <div data-testid="latest-courses-block-mock" />,
}));

vi.mock('../components/lessons/CourseAuthorsBlock', () => ({
  CourseAuthorsBlock: () => <div data-testid="course-authors-block-mock" />,
}));

describe('<DiscoverCoursesPage>', () => {
  it('рендерит заголовок, breadcrumb, обе сетки', () => {
    renderWithProviders(<DiscoverCoursesPage />);
    expect(screen.getByTestId('discover-courses-page')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('latest-courses-block-mock')).toBeInTheDocument();
    expect(screen.getByTestId('course-authors-block-mock')).toBeInTheDocument();
  });

  it('breadcrumb-link ведёт на /lessons', () => {
    const { container } = renderWithProviders(<DiscoverCoursesPage />);
    const link = container.querySelector(
      '[data-testid="discover-courses-page"] a[href="/lessons"]',
    );
    expect(link).not.toBeNull();
  });

  it('document.title обновляется', () => {
    const prev = document.title;
    renderWithProviders(<DiscoverCoursesPage />);
    expect(document.title).toContain('Kingside');
    document.title = prev;
  });
});
