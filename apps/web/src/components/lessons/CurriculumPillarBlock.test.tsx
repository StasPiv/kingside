import { describe, it, expect } from 'vitest';
import type { CourseListItem } from '@kingside/shared';

import { renderWithProviders, screen } from '../../test/test-utils';
import { CurriculumPillarBlock } from './CurriculumPillarBlock';

/**
 * KS-1923: Curriculum pillar — обёртка системных уровневых курсов.
 */

function mkCourse(over: Partial<CourseListItem> = {}): CourseListItem {
  return {
    id: 'c1',
    slug: 'beginner-1',
    titleI18nKey: 'lessons.beginner.title',
    descriptionI18nKey: 'lessons.beginner.description',
    level: 'beginner',
    order: 1,
    lessonCount: 5,
    progress: null,
    ...over,
  } as CourseListItem;
}

describe('<CurriculumPillarBlock>', () => {
  it('loading state → skeleton + aria-busy', () => {
    renderWithProviders(
      <CurriculumPillarBlock
        groups={[]}
        recommendedLevel={null}
        loading={true}
        error={null}
        emptyText=""
      />,
    );
    const block = screen.getByTestId('curriculum-pillar-block');
    expect(block.getAttribute('data-state')).toBe('loading');
    expect(block.getAttribute('aria-busy')).toBe('true');
  });

  it('error state → ошибка отрисована', () => {
    renderWithProviders(
      <CurriculumPillarBlock
        groups={[]}
        recommendedLevel={null}
        loading={false}
        error="Boom"
        emptyText=""
      />,
    );
    expect(
      screen.getByTestId('curriculum-pillar-block').getAttribute('data-state'),
    ).toBe('error');
    expect(screen.getByText('Boom')).toBeInTheDocument();
  });

  it('empty groups → empty-state', () => {
    renderWithProviders(
      <CurriculumPillarBlock
        groups={[]}
        recommendedLevel={null}
        loading={false}
        error={null}
        emptyText="No courses available"
      />,
    );
    expect(
      screen.getByTestId('curriculum-pillar-block').getAttribute('data-state'),
    ).toBe('empty');
    expect(screen.getByText('No courses available')).toBeInTheDocument();
  });

  it('ready: рендерит секции уровней с anchor id="level-{level}"', () => {
    const { container } = renderWithProviders(
      <CurriculumPillarBlock
        groups={[
          {
            level: 'beginner',
            items: [mkCourse({ id: 'b1', slug: 'b1' })],
          },
          {
            level: 'intermediate',
            items: [mkCourse({ id: 'i1', slug: 'i1', level: 'intermediate' })],
          },
        ]}
        recommendedLevel={'beginner'}
        loading={false}
        error={null}
        emptyText=""
      />,
    );
    expect(container.querySelector('#level-beginner')).not.toBeNull();
    expect(container.querySelector('#level-intermediate')).not.toBeNull();
    expect(screen.getByTestId('lessons-level-beginner')).toBeInTheDocument();
    expect(screen.getByTestId('lessons-level-intermediate')).toBeInTheDocument();
    expect(screen.getByTestId('lessons-recommended-badge')).toBeInTheDocument();
    expect(
      screen.getByTestId('course-link-b1').getAttribute('href'),
    ).toBe('/lessons/b1');
  });
});
