import { describe, it, expect } from 'vitest';
import type { CourseLessonSummary } from '@kingside/shared';
import { renderWithProviders, screen } from '../../test/test-utils';
import {
  CourseActiveLessonHero,
  resolveActiveLesson,
} from './CourseActiveLessonHero';

/**
 * KS-2079: тесты hero-плашки активного урока на странице курса.
 *
 * Покрытие:
 *  - `resolveActiveLesson`: чистая функция, 5 кейсов
 *    (in_progress, not_started без completed, not_started после
 *    completed, all completed, пустой список).
 *  - Рендер CourseActiveLessonHero на трёх состояниях:
 *    continue / start / completed.
 *  - Position 1-based и общее число.
 *  - CTA href ведёт на правильный slug.
 *  - Empty list → null (плашка не рендерится).
 */

function makeLesson(
  overrides: Partial<CourseLessonSummary> & {
    id: string;
    slug: string;
    order: number;
    progressState: CourseLessonSummary['progressState'];
  },
): CourseLessonSummary {
  return {
    id: overrides.id,
    slug: overrides.slug,
    order: overrides.order,
    blockKey: 'main',
    kind: 'theory',
    title: overrides.title ?? `Lesson ${overrides.order}`,
    titleI18nKey: '',
    summary: overrides.summary ?? null,
    summaryI18nKey: '',
    stepCount: overrides.stepCount ?? 10,
    completedStepsCount: overrides.completedStepsCount ?? 0,
    progressState: overrides.progressState,
    masteredAt: overrides.masteredAt ?? null,
    dueAt: overrides.dueAt ?? null,
  } as CourseLessonSummary;
}

// ─── resolveActiveLesson ────────────────────────────────────────────

describe('resolveActiveLesson', () => {
  it('первый in_progress имеет приоритет', () => {
    const lessons = [
      makeLesson({ id: '1', slug: 'a', order: 1, progressState: 'completed' }),
      makeLesson({ id: '2', slug: 'b', order: 2, progressState: 'in_progress' }),
      makeLesson({ id: '3', slug: 'c', order: 3, progressState: 'not_started' }),
    ];
    const r = resolveActiveLesson(lessons);
    expect(r?.mode).toBe('continue');
    expect(r?.lesson.slug).toBe('b');
    expect(r?.positionInCourse).toBe(2);
  });

  it('not_started + ни одного completed → start', () => {
    const lessons = [
      makeLesson({ id: '1', slug: 'a', order: 1, progressState: 'not_started' }),
      makeLesson({ id: '2', slug: 'b', order: 2, progressState: 'not_started' }),
    ];
    const r = resolveActiveLesson(lessons);
    expect(r?.mode).toBe('start');
    expect(r?.lesson.slug).toBe('a');
  });

  it('not_started, но есть completed раньше → continue', () => {
    const lessons = [
      makeLesson({ id: '1', slug: 'a', order: 1, progressState: 'completed' }),
      makeLesson({ id: '2', slug: 'b', order: 2, progressState: 'not_started' }),
    ];
    const r = resolveActiveLesson(lessons);
    expect(r?.mode).toBe('continue');
    expect(r?.lesson.slug).toBe('b');
  });

  it('все completed → null', () => {
    const lessons = [
      makeLesson({ id: '1', slug: 'a', order: 1, progressState: 'completed' }),
      makeLesson({ id: '2', slug: 'b', order: 2, progressState: 'completed' }),
    ];
    expect(resolveActiveLesson(lessons)).toBeNull();
  });

  it('пустой список → null', () => {
    expect(resolveActiveLesson([])).toBeNull();
  });
});

// ─── Рендер ────────────────────────────────────────────────────────

describe('CourseActiveLessonHero — render', () => {
  it('continue mode: eyebrow «Continue», CTA → /lessons/<course>/<lesson>, прогресс-бар', () => {
    const lessons = [
      makeLesson({ id: '1', slug: 'a', order: 1, progressState: 'completed' }),
      makeLesson({
        id: '2',
        slug: 'middle',
        order: 2,
        progressState: 'in_progress',
        stepCount: 10,
        completedStepsCount: 4,
        title: 'Endgames',
      }),
      makeLesson({ id: '3', slug: 'c', order: 3, progressState: 'not_started' }),
    ];
    renderWithProviders(
      <CourseActiveLessonHero courseSlug="my-course" lessons={lessons} />,
    );
    const hero = screen.getByTestId('course-active-hero');
    expect(hero).toHaveAttribute('data-mode', 'continue');
    expect(screen.getByTestId('course-active-hero-eyebrow')).toHaveTextContent(
      /continue/i,
    );
    expect(
      screen.getByTestId('course-active-hero-lesson-title'),
    ).toHaveTextContent('Endgames');
    const cta = screen.getByTestId('course-active-hero-cta');
    expect(cta).toHaveAttribute('href', '/lessons/my-course/middle');
    expect(
      screen.getByTestId('course-active-hero-progress-fill'),
    ).toHaveStyle({ width: '40%' });
  });

  it('start mode: eyebrow «Start learning», CTA «Start lesson»', () => {
    const lessons = [
      makeLesson({ id: '1', slug: 'first', order: 1, progressState: 'not_started' }),
      makeLesson({ id: '2', slug: 'b', order: 2, progressState: 'not_started' }),
    ];
    renderWithProviders(
      <CourseActiveLessonHero courseSlug="my-course" lessons={lessons} />,
    );
    const hero = screen.getByTestId('course-active-hero');
    expect(hero).toHaveAttribute('data-mode', 'start');
    expect(screen.getByTestId('course-active-hero-eyebrow')).toHaveTextContent(
      /start learning/i,
    );
    expect(screen.getByTestId('course-active-hero-cta')).toHaveTextContent(
      /start lesson/i,
    );
  });

  it('completed mode: вместо плашки урока — блок «Course completed»', () => {
    const lessons = [
      makeLesson({ id: '1', slug: 'a', order: 1, progressState: 'completed' }),
      makeLesson({ id: '2', slug: 'b', order: 2, progressState: 'completed' }),
    ];
    renderWithProviders(
      <CourseActiveLessonHero courseSlug="my-course" lessons={lessons} />,
    );
    const hero = screen.getByTestId('course-active-hero');
    expect(hero).toHaveAttribute('data-mode', 'completed');
    expect(hero).toHaveTextContent(/course completed/i);
    // Eyebrow и CTA в этом режиме отсутствуют.
    expect(screen.queryByTestId('course-active-hero-eyebrow')).toBeNull();
    expect(screen.queryByTestId('course-active-hero-cta')).toBeNull();
  });

  it('пустой список уроков → плашка не рендерится', () => {
    const { container } = renderWithProviders(
      <CourseActiveLessonHero courseSlug="empty" lessons={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('continue, но stepCount=0 → прогресс-бара нет', () => {
    const lessons = [
      makeLesson({
        id: '1',
        slug: 'a',
        order: 1,
        progressState: 'in_progress',
        stepCount: 0,
        completedStepsCount: 0,
      }),
    ];
    renderWithProviders(
      <CourseActiveLessonHero courseSlug="c" lessons={lessons} />,
    );
    expect(screen.getByTestId('course-active-hero')).toBeInTheDocument();
    expect(screen.queryByTestId('course-active-hero-progress')).toBeNull();
  });
});
