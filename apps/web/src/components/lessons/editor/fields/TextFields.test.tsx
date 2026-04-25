import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';

import { renderWithProviders } from '../../../../test/test-utils';
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
    expect(screen.queryByText(/Set Position/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('editor-diagram-edit-board-1'));

    // Модалка открыта, FEN-инпут предзаполнен из diagrams[1]
    expect(screen.getByText(/Set Position/i)).toBeInTheDocument();
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
    expect(screen.queryByText(/Set Position/i)).not.toBeInTheDocument();
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
