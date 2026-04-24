import { describe, it, expect, vi } from 'vitest';
import type { LessonStepType } from '@kingside/shared';

import { renderWithProviders, screen } from '../../../test/test-utils';
import { StepEditor } from './StepEditor';
import { createEmptyStep } from '../../../types/editor';

// `StepRenderer` тянет тяжёлое дерево (шахматные компоненты) — для
// unit-теста `<select>`-фильтра достаточно заглушки.
vi.mock('../StepRenderer', () => ({
  StepRenderer: () => <div data-testid="step-renderer-mock" />,
}));

vi.mock('../../MemoChessboard', () => ({
  MemoChessboard: () => <div data-testid="memo-chessboard-mock" />,
}));

/**
 * KS-1836: `restrictToTypes` prop.
 *
 * Контракт:
 *  - prop отсутствует → в `<select>` все типы, которые поддерживает редактор
 *    (7 типов — полный набор реализованных форм `<XxxFields>`).
 *  - prop задан → только пересечение с поддерживаемыми, в порядке prop'а.
 */

function renderStepEditor(
  overrides: Partial<Parameters<typeof StepEditor>[0]> = {},
) {
  const props = {
    step: createEmptyStep(0, 'text'),
    onChange: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
  return renderWithProviders(<StepEditor {...props} />);
}

function getTypeOptions(): string[] {
  const select = screen.getByTestId(/^editor-step-type-/) as HTMLSelectElement;
  return Array.from(select.options).map((o) => o.value);
}

describe('<StepEditor restrictToTypes>', () => {
  it('без prop → в select все поддерживаемые типы шага', () => {
    renderStepEditor();
    const options = getTypeOptions();
    expect(options).toEqual([
      'text',
      'puzzle',
      'quiz',
      'position',
      'game_review',
      'video',
      'endgame_drill',
    ]);
    expect(options).toHaveLength(7);
  });

  it('prop задан → в select только перечисленные типы, в порядке prop', () => {
    renderStepEditor({
      restrictToTypes: ['text', 'puzzle', 'endgame_drill'],
    });
    const options = getTypeOptions();
    expect(options).toEqual(['text', 'puzzle', 'endgame_drill']);
    expect(options).toHaveLength(3);
  });

  it('prop с одним типом → один option (крайний случай)', () => {
    renderStepEditor({
      restrictToTypes: ['text'],
    });
    expect(getTypeOptions()).toEqual(['text']);
  });

  it('prop с разным порядком → в select порядок сохранён', () => {
    renderStepEditor({
      restrictToTypes: ['video', 'text', 'puzzle'],
    });
    expect(getTypeOptions()).toEqual(['video', 'text', 'puzzle']);
  });

  it('prop включает неподдерживаемый тип (opening_drill) → фильтруется, не роняет редактор', () => {
    renderStepEditor({
      // opening_drill присутствует в LessonStepType, но редактор его не
      // поддерживает (нет emptyStepPayload и <Fields>). Ожидаем, что он
      // не окажется в select'е.
      restrictToTypes: ['text', 'opening_drill' as LessonStepType, 'puzzle'],
    });
    expect(getTypeOptions()).toEqual(['text', 'puzzle']);
  });

  it('prop пустой массив → select без option (крайний случай — авторам нечего выбирать)', () => {
    renderStepEditor({
      restrictToTypes: [],
    });
    expect(getTypeOptions()).toEqual([]);
  });
});
