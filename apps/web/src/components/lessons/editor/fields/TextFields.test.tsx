import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';

import { renderWithAuth as renderWithProviders } from '../../../../test/test-utils-auth';
import { TextFields } from './TextFields';

function getModalScope() {
  const modal = document.querySelector('.set-position-modal');
  if (!modal) throw new Error('SetPositionModal is not rendered');
  return within(modal as HTMLElement);
}

/**
 * KS-1875: Board Editor (`<SetPositionModal>`) для FEN диаграмм
 * в text-step.
 *
 * Проверяем три ключевых сценария Gherkin:
 *  - кнопка «Edit on board» открывает модалку с правильным FEN
 *  - Apply пишет результат в нужный индекс diagrams[]
 *  - Cancel/Close ничего не меняет
 *
 * `SetPositionModal` уже покрыт собственными тестами — здесь нас
 * интересует только склейка с `TextFields`.
 */

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const KARO_FEN = 'rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

describe('<TextFields> board editor', () => {
  it('кнопка «Edit on board» рендерится для каждой диаграммы', () => {
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '',
          diagrams: [{ fen: START_FEN }, { fen: KARO_FEN }],
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('editor-diagram-edit-board-0')).toBeInTheDocument();
    expect(screen.getByTestId('editor-diagram-edit-board-1')).toBeInTheDocument();
  });

  it('клик по «Edit on board» открывает SetPositionModal с FEN текущей диаграммы', () => {
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '',
          diagrams: [{ fen: START_FEN }, { fen: KARO_FEN }],
        }}
        onChange={vi.fn()}
      />,
    );
    // Сначала модалки нет
    expect(document.querySelector('.set-position-modal')).toBeNull();

    fireEvent.click(screen.getByTestId('editor-diagram-edit-board-1'));

    // Модалка открыта, FEN-инпут предзаполнен из diagrams[1]
    expect(document.querySelector('.set-position-modal')).not.toBeNull();
    const fenInput = getModalScope().getByDisplayValue(KARO_FEN);
    expect(fenInput).toBeInTheDocument();
  });

  it('Apply из модалки пишет новый FEN в правильный индекс diagrams[]', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '',
          diagrams: [{ fen: START_FEN }, { fen: KARO_FEN }],
        }}
        onChange={onChange}
      />,
    );
    // Открываем редактор для второй диаграммы
    fireEvent.click(screen.getByTestId('editor-diagram-edit-board-1'));
    // В FEN-табе меняем строку и жмём Apply
    const modal = getModalScope();
    const fenInput = modal.getByDisplayValue(KARO_FEN);
    const NEW_FEN = '8/8/8/8/4k3/8/4K3/8 w - - 0 1';
    fireEvent.change(fenInput, { target: { value: NEW_FEN } });
    fireEvent.click(modal.getByRole('button', { name: /Apply/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const updated = onChange.mock.calls[0][0];
    expect(updated.diagrams[0].fen).toBe(START_FEN);
    expect(updated.diagrams[1].fen).toBe(NEW_FEN);
  });

  it('Cancel закрывает модалку и НЕ меняет diagrams', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '',
          diagrams: [{ fen: START_FEN }],
        }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('editor-diagram-edit-board-0'));
    // редактируем FEN, но затем Cancel
    const modal = getModalScope();
    const fenInput = modal.getByDisplayValue(START_FEN);
    fireEvent.change(fenInput, { target: { value: '8/8/8/8/8/8/8/8 w - - 0 1' } });
    fireEvent.click(modal.getByRole('button', { name: /Cancel/i }));

    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector('.set-position-modal')).toBeNull();
  });

  it('input FEN остаётся редактируемым (контракт сохраняем)', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '',
          diagrams: [{ fen: START_FEN }],
        }}
        onChange={onChange}
      />,
    );
    const fenInput = screen.getByTestId('editor-diagram-fen-0') as HTMLInputElement;
    fireEvent.change(fenInput, { target: { value: KARO_FEN } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].diagrams[0].fen).toBe(KARO_FEN);
  });
});

/**
 * KS-2572: collapsible-карточки диаграмм + reorder/duplicate/delete +
 * orphan-warning + интеграция `<DiagramEditor>` для визуального
 * редактирования стрелок/highlights.
 *
 * `<DiagramEditor>` мокаем — у него собственный набор тестов
 * (KS-2571), здесь нас интересует только склейка с TextFields.
 */
vi.mock('../shared/DiagramEditor', () => ({
  DiagramEditor: (props: {
    fen: string;
    arrows?: Array<{ from: string; to: string }>;
    highlightedSquares?: Array<{ square: string }>;
    onChange: (next: {
      fen: string;
      caption?: string;
      orientation?: 'white' | 'black';
      arrows: Array<{ from: string; to: string; color?: string }>;
      highlightedSquares: Array<{ square: string; color?: string }>;
    }) => void;
  }) => (
    <div
      data-testid="diagram-editor-mock"
      data-fen={props.fen}
      data-arrows-count={props.arrows?.length ?? 0}
      data-highlights-count={props.highlightedSquares?.length ?? 0}
    >
      <button
        type="button"
        data-testid="diagram-editor-mock-add-arrow"
        onClick={() =>
          props.onChange({
            fen: props.fen,
            arrows: [
              ...(props.arrows ?? []),
              {
                from: 'e2',
                to: 'e4',
                color: 'rgba(235, 97, 80, 0.8)',
              },
            ],
            highlightedSquares: props.highlightedSquares ?? [],
          })
        }
      >
        +arrow
      </button>
    </div>
  ),
}));

describe('<TextFields> KS-2572 collapsible diagram cards', () => {
  it('по умолчанию все диаграммы развёрнуты — DiagramEditor виден для каждой', () => {
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '{{diagram:0}}\n\n{{diagram:1}}',
          diagrams: [{ fen: START_FEN }, { fen: KARO_FEN }],
        }}
        onChange={vi.fn()}
      />,
    );
    const editors = screen.getAllByTestId('diagram-editor-mock');
    expect(editors).toHaveLength(2);
    expect(editors[0].getAttribute('data-fen')).toBe(START_FEN);
    expect(editors[1].getAttribute('data-fen')).toBe(KARO_FEN);
  });

  it('toggle сворачивает карточку — DiagramEditor скрыт, заголовок остаётся', () => {
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '',
          diagrams: [{ fen: START_FEN }, { fen: KARO_FEN }],
        }}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('editor-diagram-toggle-0'));
    const editors = screen.getAllByTestId('diagram-editor-mock');
    // Первый свёрнут → 1 editor (только для второй карточки)
    expect(editors).toHaveLength(1);
    // Заголовок и плейсхолдер первой карточки остаются
    expect(screen.getByTestId('editor-diagram-card-0')).toBeInTheDocument();
    expect(screen.getByTestId('editor-diagram-ref-0')).toBeInTheDocument();
  });

  it('кнопка «+ Добавить диаграмму» добавляет третью со стартовой FEN и плейсхолдером', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '{{diagram:0}}\n\n{{diagram:1}}',
          diagrams: [{ fen: START_FEN }, { fen: KARO_FEN }],
        }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('editor-step-text-add-diagram'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const updated = onChange.mock.calls[0][0];
    expect(updated.diagrams).toHaveLength(3);
    expect(updated.diagrams[2].fen).toBe(START_FEN);
    expect(updated.diagrams[2].arrows).toEqual([]);
    expect(updated.diagrams[2].highlightedSquares).toEqual([]);
    expect(updated.bodyMarkdown).toMatch(/\{\{diagram:2\}\}$/);
  });

  it('drawing внутри DiagramEditor пробрасывается в payload.diagrams[N].arrows', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '',
          diagrams: [{ fen: START_FEN }, { fen: KARO_FEN }],
        }}
        onChange={onChange}
      />,
    );
    // DiagramEditor для второй диаграммы — клик на «+arrow»
    const editors = screen.getAllByTestId('diagram-editor-mock-add-arrow');
    fireEvent.click(editors[1]);
    expect(onChange).toHaveBeenCalledTimes(1);
    const updated = onChange.mock.calls[0][0];
    expect(updated.diagrams[0].arrows).toBeUndefined(); // первая не тронута
    expect(updated.diagrams[1].arrows).toEqual([
      { from: 'e2', to: 'e4', color: 'rgba(235, 97, 80, 0.8)' },
    ]);
  });

  it('кнопка «Удалить диаграмму» удаляет запись из diagrams[]', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '',
          diagrams: [{ fen: START_FEN }, { fen: KARO_FEN }],
        }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('editor-diagram-remove-0'));
    const updated = onChange.mock.calls[0][0];
    expect(updated.diagrams).toEqual([{ fen: KARO_FEN }]);
  });

  it('удаление диаграммы НЕ трогает bodyMarkdown (плейсхолдеры остаются)', () => {
    const md = '{{diagram:0}}\n\n{{diagram:1}}';
    const onChange = vi.fn();
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: md,
          diagrams: [{ fen: START_FEN }, { fen: KARO_FEN }],
        }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('editor-diagram-remove-1'));
    const updated = onChange.mock.calls[0][0];
    expect(updated.bodyMarkdown).toBe(md);
  });

  it('orphan-warning показывается, если в md есть {{diagram:N}} > diagrams.length', () => {
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '{{diagram:0}}\n\n{{diagram:5}}',
          diagrams: [{ fen: START_FEN }],
        }}
        onChange={vi.fn()}
      />,
    );
    const warn = screen.getByTestId('editor-diagrams-orphan-warning');
    expect(warn.textContent).toMatch(/\{\{diagram:5\}\}/);
  });

  it('orphan-warning не показывается, если все плейсхолдеры валидны', () => {
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '{{diagram:0}}',
          diagrams: [{ fen: START_FEN }],
        }}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.queryByTestId('editor-diagrams-orphan-warning'),
    ).not.toBeInTheDocument();
  });

  it('кнопка «Дублировать» создаёт глубокую копию следующим элементом', () => {
    const arrows = [{ from: 'e2', to: 'e4', color: 'rgba(235, 97, 80, 0.8)' }];
    const onChange = vi.fn();
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '',
          diagrams: [{ fen: START_FEN, arrows }, { fen: KARO_FEN }],
        }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('editor-diagram-duplicate-0'));
    const updated = onChange.mock.calls[0][0];
    expect(updated.diagrams).toHaveLength(3);
    expect(updated.diagrams[1].fen).toBe(START_FEN);
    expect(updated.diagrams[1].arrows).toEqual(arrows);
    // Глубокая копия — не та же ссылка
    expect(updated.diagrams[1].arrows).not.toBe(arrows);
    // Третья позиция = старый KARO
    expect(updated.diagrams[2].fen).toBe(KARO_FEN);
  });

  it('кнопки «↑/↓» меняют порядок диаграмм', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '',
          diagrams: [{ fen: START_FEN }, { fen: KARO_FEN }],
        }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('editor-diagram-move-down-0'));
    const updated = onChange.mock.calls[0][0];
    expect(updated.diagrams.map((d: { fen: string }) => d.fen)).toEqual([
      KARO_FEN,
      START_FEN,
    ]);
  });

  it('кнопки «↑» disabled на первом, «↓» disabled на последнем', () => {
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '',
          diagrams: [{ fen: START_FEN }, { fen: KARO_FEN }],
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('editor-diagram-move-up-0')).toBeDisabled();
    expect(screen.getByTestId('editor-diagram-move-down-1')).toBeDisabled();
    expect(screen.getByTestId('editor-diagram-move-down-0')).not.toBeDisabled();
    expect(screen.getByTestId('editor-diagram-move-up-1')).not.toBeDisabled();
  });

  it('заголовок «Diagram N» виден для каждой карточки', () => {
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '',
          diagrams: [{ fen: START_FEN }, { fen: KARO_FEN }],
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Diagram 1')).toBeInTheDocument();
    expect(screen.getByText('Diagram 2')).toBeInTheDocument();
  });

  it('подсказка `{{diagram:N}}` остаётся (KS-1827 hint)', () => {
    renderWithProviders(
      <TextFields
        payload={{
          type: 'text',
          bodyMarkdown: '',
          diagrams: [{ fen: START_FEN }],
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('editor-diagrams-hint')).toBeInTheDocument();
    expect(screen.getByTestId('editor-diagram-ref-0').textContent).toBe(
      '{{diagram:0}}',
    );
  });
});
