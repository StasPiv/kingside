import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type {
  UserLessonDto,
  UserLessonStepDto,
} from '@kingside/shared';

import { renderWithProviders, screen } from '../../../../test/test-utils';
import { CourseOutline } from './CourseOutline';

/**
 * KS-1854 (FE-R6): `CourseOutline`.
 */

function mkLesson(over: Partial<UserLessonDto> = {}): UserLessonDto {
  return {
    id: 'l1',
    userCourseId: 'c1',
    order: 0,
    title: 'L1',
    estMinutes: null,
    stepCount: 0,
    ...over,
  };
}

function mkStep(over: Partial<UserLessonStepDto> = {}): UserLessonStepDto {
  return {
    id: 's1',
    userLessonId: 'l1',
    order: 0,
    type: 'text',
    payload: { type: 'text', bodyMarkdown: '', diagrams: [] },
    ...over,
  };
}

function renderOutline(over?: Partial<Parameters<typeof CourseOutline>[0]>) {
  const props = {
    lessons: [mkLesson()],
    activeLessonId: null,
    stepsByLesson: {},
    expandedLessonIds: new Set<string>(),
    onSelectLesson: vi.fn(),
    onToggleLessonExpand: vi.fn(),
    onAddLesson: vi.fn(),
    onSelectStep: vi.fn(),
    ...over,
  };
  return { ...renderWithProviders(<CourseOutline {...props} />), props };
}

describe('<CourseOutline>', () => {
  it('пустой список → «No lessons yet» + CTA «Add lesson»', () => {
    renderOutline({ lessons: [] });
    expect(screen.getByTestId('course-outline-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('course-outline-list')).not.toBeInTheDocument();
    expect(screen.getByTestId('course-outline-add-lesson')).toBeInTheDocument();
  });

  it('список уроков: каждый отрендерен с title + счётчик шагов', () => {
    renderOutline({
      lessons: [
        mkLesson({ id: 'l1', title: 'L1', stepCount: 3 }),
        mkLesson({ id: 'l2', title: 'L2', stepCount: 5 }),
      ],
    });
    expect(screen.getByTestId('course-outline-lesson-l1')).toBeInTheDocument();
    expect(screen.getByTestId('course-outline-lesson-l2')).toBeInTheDocument();
    expect(
      screen.getByTestId('course-outline-lesson-stepcount-l1').textContent,
    ).toMatch(/3/);
    expect(
      screen.getByTestId('course-outline-lesson-stepcount-l2').textContent,
    ).toMatch(/5/);
  });

  it('activeLessonId → подсветка через data-active=true + aria-current', () => {
    renderOutline({
      lessons: [
        mkLesson({ id: 'l1' }),
        mkLesson({ id: 'l2' }),
      ],
      activeLessonId: 'l2',
    });
    expect(
      screen.getByTestId('course-outline-lesson-l1').getAttribute('data-active'),
    ).toBe('false');
    expect(
      screen.getByTestId('course-outline-lesson-l2').getAttribute('data-active'),
    ).toBe('true');
    expect(
      screen
        .getByTestId('course-outline-lesson-select-l2')
        .getAttribute('aria-current'),
    ).toBe('true');
  });

  it('клик по уроку → onSelectLesson(id)', () => {
    const { props } = renderOutline({
      lessons: [mkLesson({ id: 'l1' }), mkLesson({ id: 'l2' })],
    });
    fireEvent.click(screen.getByTestId('course-outline-lesson-select-l2'));
    expect(props.onSelectLesson).toHaveBeenCalledWith('l2');
  });

  it('клик по expand → onToggleLessonExpand(id)', () => {
    const { props } = renderOutline({
      lessons: [mkLesson({ id: 'l1' })],
    });
    fireEvent.click(screen.getByTestId('course-outline-expand-l1'));
    expect(props.onToggleLessonExpand).toHaveBeenCalledWith('l1');
  });

  it('expanded → видны шаги с иконками и порядковыми номерами', () => {
    const steps = [
      mkStep({ id: 's1', type: 'text' }),
      mkStep({ id: 's2', type: 'puzzle' }),
      mkStep({ id: 's3', type: 'endgame_drill' }),
    ];
    renderOutline({
      lessons: [mkLesson({ id: 'l1', stepCount: 3 })],
      stepsByLesson: { l1: steps },
      expandedLessonIds: new Set(['l1']),
    });
    expect(screen.getByTestId('course-outline-step-s1')).toBeInTheDocument();
    expect(screen.getByTestId('course-outline-step-s2')).toBeInTheDocument();
    expect(screen.getByTestId('course-outline-step-s3')).toBeInTheDocument();
  });

  it('expanded + пустой список шагов → empty-плашка', () => {
    renderOutline({
      lessons: [mkLesson({ id: 'l1' })],
      stepsByLesson: { l1: [] },
      expandedLessonIds: new Set(['l1']),
    });
    expect(
      screen.getByTestId('course-outline-steps-empty-l1'),
    ).toBeInTheDocument();
  });

  it('клик по step → onSelectStep(lessonId, stepId)', () => {
    const { props } = renderOutline({
      lessons: [mkLesson({ id: 'l1' })],
      stepsByLesson: { l1: [mkStep({ id: 's1' })] },
      expandedLessonIds: new Set(['l1']),
    });
    const btn = screen
      .getByTestId('course-outline-step-s1')
      .querySelector('button');
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(props.onSelectStep).toHaveBeenCalledWith('l1', 's1');
  });

  it('кнопка «Add lesson» → onAddLesson', () => {
    const { props } = renderOutline();
    fireEvent.click(screen.getByTestId('course-outline-add-lesson'));
    expect(props.onAddLesson).toHaveBeenCalledTimes(1);
  });

  it('busy=true → CTA «Add lesson» disabled', () => {
    renderOutline({ busy: true });
    expect(
      (screen.getByTestId('course-outline-add-lesson') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('renderLessonDragHandle — кастомный drag-handle вместо дефолта', () => {
    renderOutline({
      lessons: [mkLesson({ id: 'l1' })],
      renderLessonDragHandle: (l) => (
        <div data-testid={`custom-drag-${l.id}`}>X</div>
      ),
    });
    expect(screen.getByTestId('custom-drag-l1')).toBeInTheDocument();
    expect(
      screen.queryByTestId('course-outline-drag-l1'),
    ).not.toBeInTheDocument();
  });
});
