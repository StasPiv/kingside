import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { UserLessonDto, UserLessonStepDto } from '@kingside/shared';

import { renderWithProviders, screen } from '../../../../test/test-utils';
import { LessonOverview } from './LessonOverview';

/**
 * KS-1853 (FE-R5): `LessonOverview`.
 */

// StepCard тянет *Fields и StepRenderer — мокаем для изолированного теста
// LessonOverview-логики.
vi.mock('./StepCard', () => ({
  StepCard: (props: {
    step: { id: string };
    index: number;
    expanded: boolean;
    onToggleExpand: () => void;
    onDelete: () => void;
    onDuplicate: () => void;
    onPayloadChange: (p: unknown) => void;
    saveStatus: string;
  }) => (
    <div
      data-testid={`step-card-mock-${props.step.id}`}
      data-index={props.index}
      data-expanded={props.expanded}
      data-save-status={props.saveStatus}
    >
      <button
        type="button"
        onClick={props.onToggleExpand}
        data-testid={`step-card-mock-toggle-${props.step.id}`}
      />
      <button
        type="button"
        onClick={props.onDelete}
        data-testid={`step-card-mock-delete-${props.step.id}`}
      />
      <button
        type="button"
        onClick={props.onDuplicate}
        data-testid={`step-card-mock-duplicate-${props.step.id}`}
      />
    </div>
  ),
}));

function mkLesson(over: Partial<UserLessonDto> = {}): UserLessonDto {
  return {
    id: 'l1',
    userCourseId: 'c1',
    order: 0,
    title: 'Lesson 1',
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

function render(over: Partial<Parameters<typeof LessonOverview>[0]> = {}) {
  const props = {
    lesson: mkLesson(),
    steps: [] as UserLessonStepDto[],
    expandedStepIds: new Set<string>(),
    onTitleChange: vi.fn(),
    onEstMinutesChange: vi.fn(),
    onDeleteLesson: vi.fn(),
    onToggleStepExpand: vi.fn(),
    onStepPayloadChange: vi.fn(),
    onDeleteStep: vi.fn(),
    onDuplicateStep: vi.fn(),
    onAddStep: vi.fn(),
    onMoveStep: vi.fn(),
    ...over,
  };
  return { ...renderWithProviders(<LessonOverview {...props} />), props };
}

describe('<LessonOverview>', () => {
  it('рендерит title input, estMinutes input, delete-кнопку', () => {
    render();
    expect(screen.getByTestId('lesson-overview-l1')).toBeInTheDocument();
    expect(screen.getByTestId('lesson-overview-title-l1')).toBeInTheDocument();
    expect(screen.getByTestId('lesson-overview-est-l1')).toBeInTheDocument();
    expect(screen.getByTestId('lesson-overview-delete-l1')).toBeInTheDocument();
  });

  it('title input: onChange → onTitleChange', () => {
    const { props } = render();
    fireEvent.change(screen.getByTestId('lesson-overview-title-l1'), {
      target: { value: 'Renamed' },
    });
    expect(props.onTitleChange).toHaveBeenCalledWith('Renamed');
  });

  it('estMinutes input: число → onEstMinutesChange(num)', () => {
    const { props } = render();
    fireEvent.change(screen.getByTestId('lesson-overview-est-l1'), {
      target: { value: '15' },
    });
    expect(props.onEstMinutesChange).toHaveBeenCalledWith(15);
  });

  it('estMinutes input: пусто → onEstMinutesChange(null)', () => {
    const { props } = render({
      lesson: mkLesson({ estMinutes: 10 }),
    });
    fireEvent.change(screen.getByTestId('lesson-overview-est-l1'), {
      target: { value: '' },
    });
    expect(props.onEstMinutesChange).toHaveBeenCalledWith(null);
  });

  it('delete → onDeleteLesson', () => {
    const { props } = render();
    fireEvent.click(screen.getByTestId('lesson-overview-delete-l1'));
    expect(props.onDeleteLesson).toHaveBeenCalledTimes(1);
  });

  it('пустой список шагов → рендерит AddStepEmptyState, без списка StepCard', () => {
    render({ steps: [] });
    expect(screen.getByTestId('add-step-empty-state')).toBeInTheDocument();
    expect(
      screen.queryByTestId('lesson-overview-steps-l1'),
    ).not.toBeInTheDocument();
  });

  it('AddStepEmptyState → выбор типа + CTA → onAddStep(type)', () => {
    const { props } = render();
    fireEvent.click(
      screen.getByTestId('add-step-empty-picker-option-puzzle'),
    );
    fireEvent.click(screen.getByTestId('add-step-empty-cta'));
    expect(props.onAddStep).toHaveBeenCalledWith('puzzle');
  });

  it('список шагов → StepCard для каждого + reorder ↑↓ кнопки', () => {
    render({
      steps: [
        mkStep({ id: 's1' }),
        mkStep({ id: 's2' }),
        mkStep({ id: 's3' }),
      ],
    });
    expect(screen.getByTestId('step-card-mock-s1')).toBeInTheDocument();
    expect(screen.getByTestId('step-card-mock-s3')).toBeInTheDocument();
    // Первый не может двигаться вверх, последний — вниз.
    expect(
      (screen.getByTestId('lesson-overview-step-up-s1') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByTestId('lesson-overview-step-down-s3') as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    // Средние — активны.
    expect(
      (
        screen.getByTestId('lesson-overview-step-up-s2') as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it('клик ↑ у среднего шага → onMoveStep(id, -1)', () => {
    const { props } = render({
      steps: [mkStep({ id: 's1' }), mkStep({ id: 's2' })],
    });
    fireEvent.click(screen.getByTestId('lesson-overview-step-up-s2'));
    expect(props.onMoveStep).toHaveBeenCalledWith('s2', -1);
  });

  it('клик ↓ → onMoveStep(id, 1)', () => {
    const { props } = render({
      steps: [mkStep({ id: 's1' }), mkStep({ id: 's2' })],
    });
    fireEvent.click(screen.getByTestId('lesson-overview-step-down-s1'));
    expect(props.onMoveStep).toHaveBeenCalledWith('s1', 1);
  });

  it('StepCard раскрытие → onToggleStepExpand', () => {
    const { props } = render({
      steps: [mkStep({ id: 's1' })],
    });
    fireEvent.click(screen.getByTestId('step-card-mock-toggle-s1'));
    expect(props.onToggleStepExpand).toHaveBeenCalledWith('s1');
  });

  it('StepCard delete/duplicate → onDeleteStep/onDuplicateStep', () => {
    const { props } = render({
      steps: [mkStep({ id: 's1' })],
    });
    fireEvent.click(screen.getByTestId('step-card-mock-delete-s1'));
    fireEvent.click(screen.getByTestId('step-card-mock-duplicate-s1'));
    expect(props.onDeleteStep).toHaveBeenCalledWith('s1');
    expect(props.onDuplicateStep).toHaveBeenCalledWith('s1');
  });

  it('step save-status прокидывается в StepCard', () => {
    render({
      steps: [mkStep({ id: 's1' })],
      stepSaveStatusById: { s1: 'saving' },
    });
    expect(
      screen.getByTestId('step-card-mock-s1').getAttribute('data-save-status'),
    ).toBe('saving');
  });

  it('«+ Add step» inline-picker: при открытии — picker + cancel + confirm (disabled до выбора)', () => {
    render({ steps: [mkStep({ id: 's1' })] });
    fireEvent.click(screen.getByTestId('lesson-overview-add-step-btn-l1'));
    expect(
      screen.getByTestId('lesson-overview-add-step-picker-l1'),
    ).toBeInTheDocument();
    const confirm = screen.getByTestId(
      'lesson-overview-add-step-confirm-l1',
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(
      screen.getByTestId('lesson-overview-add-step-types-l1-option-endgame_drill'),
    );
    expect(confirm.disabled).toBe(false);
  });

  it('«+ Add step» confirm → onAddStep(type) + picker закрывается', () => {
    const { props } = render({ steps: [mkStep({ id: 's1' })] });
    fireEvent.click(screen.getByTestId('lesson-overview-add-step-btn-l1'));
    fireEvent.click(
      screen.getByTestId('lesson-overview-add-step-types-l1-option-text'),
    );
    fireEvent.click(screen.getByTestId('lesson-overview-add-step-confirm-l1'));
    expect(props.onAddStep).toHaveBeenCalledWith('text');
    expect(
      screen.queryByTestId('lesson-overview-add-step-picker-l1'),
    ).not.toBeInTheDocument();
  });

  it('«+ Add step» cancel закрывает picker, onAddStep не вызван', () => {
    const { props } = render({ steps: [mkStep({ id: 's1' })] });
    fireEvent.click(screen.getByTestId('lesson-overview-add-step-btn-l1'));
    fireEvent.click(screen.getByTestId('lesson-overview-add-step-cancel-l1'));
    expect(
      screen.queryByTestId('lesson-overview-add-step-picker-l1'),
    ).not.toBeInTheDocument();
    expect(props.onAddStep).not.toHaveBeenCalled();
  });

  it('busy=true → все интерактивы disabled', () => {
    render({ steps: [mkStep({ id: 's1' })], busy: true });
    expect(
      (screen.getByTestId('lesson-overview-title-l1') as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('lesson-overview-delete-l1') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('lesson-overview-add-step-btn-l1') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
