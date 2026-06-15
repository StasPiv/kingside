import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import type { StepPayload } from '@kingside/shared';

import { renderWithAuth as renderWithProviders } from '../../../../test/test-utils-auth';
import { EndgameDrillFields } from './EndgameDrillFields';

/**
 * KS-1906: Board Editor (`<SetPositionModal>`) для FEN эндшпиля
 * (`endgame_drill`). Тот же паттерн что в KS-1875 для диаграмм
 * лекции. `SetPositionModal` уже покрыт собственными тестами —
 * здесь нас интересует склейка с `EndgameDrillFields`.
 */

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ENDGAME_FEN = '8/8/8/8/4k3/8/4K3/8 w - - 0 1';
const NEW_FEN = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';

function getModalScope() {
  const modal = document.querySelector('.set-position-modal');
  if (!modal) throw new Error('SetPositionModal is not rendered');
  return within(modal as HTMLElement);
}

function mkPayload(
  over: Partial<Extract<StepPayload, { type: 'endgame_drill' }>> = {},
): Extract<StepPayload, { type: 'endgame_drill' }> {
  return {
    type: 'endgame_drill',
    fen: ENDGAME_FEN,
    playerSide: 'white',
    skillLevel: 5,
    winCondition: { kind: 'mate' },
    ...over,
  };
}

describe('<EndgameDrillFields> board editor (KS-1906)', () => {
  it('кнопка «Edit on board» рендерится рядом с FEN-инпутом', () => {
    renderWithProviders(
      <EndgameDrillFields payload={mkPayload()} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('editor-endgame-fen')).toBeInTheDocument();
    expect(screen.getByTestId('editor-endgame-edit-board')).toBeInTheDocument();
  });

  it('клик по «Edit on board» открывает SetPositionModal с FEN из payload', () => {
    renderWithProviders(
      <EndgameDrillFields payload={mkPayload()} onChange={vi.fn()} />,
    );
    expect(screen.queryByText(/Set Position/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('editor-endgame-edit-board'));

    expect(screen.getByText(/Set Position/i)).toBeInTheDocument();
    const fenInput = getModalScope().getByDisplayValue(ENDGAME_FEN);
    expect(fenInput).toBeInTheDocument();
  });

  it('Apply из модалки пишет новый FEN в payload и закрывает модалку', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <EndgameDrillFields payload={mkPayload()} onChange={onChange} />,
    );

    fireEvent.click(screen.getByTestId('editor-endgame-edit-board'));
    const modal = getModalScope();
    const fenInput = modal.getByDisplayValue(ENDGAME_FEN);
    fireEvent.change(fenInput, { target: { value: NEW_FEN } });
    fireEvent.click(modal.getByRole('button', { name: /Apply/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const updated = onChange.mock.calls[0][0];
    expect(updated.type).toBe('endgame_drill');
    expect(updated.fen).toBe(NEW_FEN);
    // прочие поля не трогаем
    expect(updated.playerSide).toBe('white');
    expect(updated.skillLevel).toBe(5);
    expect(updated.winCondition.kind).toBe('mate');
    // модалка закрылась
    expect(screen.queryByText(/Set Position/i)).not.toBeInTheDocument();
  });

  it('Cancel закрывает модалку и НЕ меняет payload.fen', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <EndgameDrillFields payload={mkPayload()} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('editor-endgame-edit-board'));
    const modal = getModalScope();
    const fenInput = modal.getByDisplayValue(ENDGAME_FEN);
    fireEvent.change(fenInput, { target: { value: NEW_FEN } });
    fireEvent.click(modal.getByRole('button', { name: /Cancel/i }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText(/Set Position/i)).not.toBeInTheDocument();
  });

  it('обычный ввод в FEN-input по-прежнему пишет в payload', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <EndgameDrillFields payload={mkPayload()} onChange={onChange} />,
    );
    const fenInput = screen.getByTestId('editor-endgame-fen') as HTMLInputElement;
    fireEvent.change(fenInput, { target: { value: START_FEN } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].fen).toBe(START_FEN);
  });
});
