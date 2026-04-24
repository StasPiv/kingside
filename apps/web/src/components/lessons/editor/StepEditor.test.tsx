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

/**
 * KS-1827 bugfix: редактор text-шага должен автоматически встраивать
 * `{{diagram:N}}`-маркер в markdown при добавлении новой диаграммы,
 * иначе читатель её не увидит (TextStep рендерит только
 * отреферированные диаграммы + orphan'ы в конец).
 */
describe('<StepEditor> TextFields: auto-insert diagram marker', () => {
  it('«+ Добавить диаграмму» дописывает {{diagram:0}} к bodyMarkdown', async () => {
    const onChange = vi.fn();
    const step = createEmptyStep(0, 'text');
    const { fireEvent } = await import('@testing-library/react');
    renderWithProviders(
      <StepEditor
        step={{
          ...step,
          payload: { type: 'text', bodyMarkdown: 'Какой-то текст', diagrams: [] },
        }}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('editor-step-text-add-diagram'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const nextStep = onChange.mock.calls[0][0];
    expect(nextStep.payload.bodyMarkdown).toBe(
      'Какой-то текст\n\n{{diagram:0}}',
    );
    expect(nextStep.payload.diagrams).toHaveLength(1);
  });

  it('вторая диаграмма получает {{diagram:1}} на новой строке', async () => {
    const onChange = vi.fn();
    const { fireEvent } = await import('@testing-library/react');
    renderWithProviders(
      <StepEditor
        step={{
          id: 's1',
          order: 0,
          type: 'text',
          payload: {
            type: 'text',
            bodyMarkdown: 'intro\n\n{{diagram:0}}',
            diagrams: [{ fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' }],
          },
        }}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('editor-step-text-add-diagram'));
    const nextStep = onChange.mock.calls[0][0];
    expect(nextStep.payload.bodyMarkdown).toBe(
      'intro\n\n{{diagram:0}}\n\n{{diagram:1}}',
    );
    expect(nextStep.payload.diagrams).toHaveLength(2);
  });

  it('пустой markdown → маркер {{diagram:0}} без префикса', async () => {
    const onChange = vi.fn();
    const { fireEvent } = await import('@testing-library/react');
    renderWithProviders(
      <StepEditor
        step={{
          id: 's1',
          order: 0,
          type: 'text',
          payload: { type: 'text', bodyMarkdown: '', diagrams: [] },
        }}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('editor-step-text-add-diagram'));
    const nextStep = onChange.mock.calls[0][0];
    expect(nextStep.payload.bodyMarkdown).toBe('{{diagram:0}}');
  });

  it('ref-блок `{{diagram:N}}` показывается для каждой declared-диаграммы', () => {
    renderWithProviders(
      <StepEditor
        step={{
          id: 's1',
          order: 0,
          type: 'text',
          payload: {
            type: 'text',
            bodyMarkdown: '',
            diagrams: [
              { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
              { fen: 'rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2' },
            ],
          },
        }}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByTestId('editor-diagram-ref-0').textContent).toMatch(
      /\{\{diagram:0\}\}/,
    );
    expect(screen.getByTestId('editor-diagram-ref-1').textContent).toMatch(
      /\{\{diagram:1\}\}/,
    );
  });
});
