import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../../../test/test-utils';
import { StepTypePicker, USER_STEP_TYPES } from './StepTypePicker';

/**
 * KS-1851 (FE-R3): `StepTypePicker`.
 */

describe('<StepTypePicker>', () => {
  it('рендерит ровно 4 опции (whitelist UserStepType): text/puzzle/endgame_drill/quiz', () => {
    // KS-2574: добавлен `quiz` в USER_STEP_TYPES после расширения
    // shared union (KS-2570) и появления `<QuizStepEditor>` (KS-2573).
    renderWithProviders(<StepTypePicker value={null} onSelect={vi.fn()} />);
    expect(USER_STEP_TYPES).toEqual([
      'text',
      'puzzle',
      'endgame_drill',
      'quiz',
    ]);
    for (const type of USER_STEP_TYPES) {
      expect(
        screen.getByTestId(`step-type-picker-option-${type}`),
      ).toBeInTheDocument();
    }
  });

  it('value=null → ни одна карточка не aria-checked=true', () => {
    renderWithProviders(<StepTypePicker value={null} onSelect={vi.fn()} />);
    for (const type of USER_STEP_TYPES) {
      const card = screen.getByTestId(`step-type-picker-option-${type}`);
      expect(card.getAttribute('aria-checked')).toBe('false');
    }
  });

  it('value=puzzle → только puzzle aria-checked=true и data-selected=true', () => {
    renderWithProviders(<StepTypePicker value="puzzle" onSelect={vi.fn()} />);
    const puzzle = screen.getByTestId('step-type-picker-option-puzzle');
    expect(puzzle.getAttribute('aria-checked')).toBe('true');
    expect(puzzle.getAttribute('data-selected')).toBe('true');
    const text = screen.getByTestId('step-type-picker-option-text');
    expect(text.getAttribute('aria-checked')).toBe('false');
  });

  it('клик по карточке → onSelect(type)', () => {
    const onSelect = vi.fn();
    renderWithProviders(<StepTypePicker value={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('step-type-picker-option-endgame_drill'));
    expect(onSelect).toHaveBeenCalledWith('endgame_drill');
  });

  it('disabled → кнопки disabled и клик не вызывает onSelect', () => {
    const onSelect = vi.fn();
    renderWithProviders(
      <StepTypePicker value={null} onSelect={onSelect} disabled />,
    );
    const card = screen.getByTestId('step-type-picker-option-text') as HTMLButtonElement;
    expect(card.disabled).toBe(true);
    fireEvent.click(card);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('кастомный testIdPrefix применяется ко всем опциям', () => {
    renderWithProviders(
      <StepTypePicker
        value={null}
        onSelect={vi.fn()}
        testIdPrefix="custom-picker"
      />,
    );
    expect(screen.getByTestId('custom-picker')).toBeInTheDocument();
    expect(screen.getByTestId('custom-picker-option-text')).toBeInTheDocument();
    expect(screen.queryByTestId('step-type-picker')).not.toBeInTheDocument();
  });

  it('role=radiogroup + каждая карточка role=radio (семантика a11y)', () => {
    renderWithProviders(<StepTypePicker value="text" onSelect={vi.fn()} />);
    const group = screen.getByTestId('step-type-picker');
    expect(group.getAttribute('role')).toBe('radiogroup');
    for (const type of USER_STEP_TYPES) {
      expect(
        screen.getByTestId(`step-type-picker-option-${type}`).getAttribute('role'),
      ).toBe('radio');
    }
  });
});
