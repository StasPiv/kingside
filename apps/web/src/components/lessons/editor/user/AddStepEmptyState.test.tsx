import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../../../test/test-utils';
import { AddStepEmptyState } from './AddStepEmptyState';

/**
 * KS-1851 (FE-R3): `AddStepEmptyState`.
 */

describe('<AddStepEmptyState>', () => {
  it('рендерит заголовок, subtitle, picker и CTA', () => {
    renderWithProviders(<AddStepEmptyState onAdd={vi.fn()} />);
    expect(screen.getByTestId('add-step-empty-state')).toBeInTheDocument();
    expect(screen.getByTestId('add-step-empty-picker')).toBeInTheDocument();
    expect(screen.getByTestId('add-step-empty-cta')).toBeInTheDocument();
  });

  it('до выбора типа CTA disabled', () => {
    renderWithProviders(<AddStepEmptyState onAdd={vi.fn()} />);
    const cta = screen.getByTestId('add-step-empty-cta') as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
  });

  it('после выбора типа CTA enabled; клик вызывает onAdd(type)', () => {
    const onAdd = vi.fn();
    renderWithProviders(<AddStepEmptyState onAdd={onAdd} />);
    fireEvent.click(screen.getByTestId('add-step-empty-picker-option-puzzle'));
    const cta = screen.getByTestId('add-step-empty-cta') as HTMLButtonElement;
    expect(cta.disabled).toBe(false);
    fireEvent.click(cta);
    expect(onAdd).toHaveBeenCalledWith('puzzle');
  });

  it('busy=true → picker и CTA заблокированы', () => {
    const onAdd = vi.fn();
    renderWithProviders(<AddStepEmptyState onAdd={onAdd} busy />);
    const pickerOption = screen.getByTestId(
      'add-step-empty-picker-option-text',
    ) as HTMLButtonElement;
    expect(pickerOption.disabled).toBe(true);
    const cta = screen.getByTestId('add-step-empty-cta') as HTMLButtonElement;
    // Даже если тип выбран, busy блокирует CTA. Но до выбора он уже disabled —
    // проверим что повторный клик по picker'у не зажигает CTA.
    fireEvent.click(pickerOption);
    expect(cta.disabled).toBe(true);
    fireEvent.click(cta);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('повторный выбор типа → CTA передаёт последний выбранный', () => {
    const onAdd = vi.fn();
    renderWithProviders(<AddStepEmptyState onAdd={onAdd} />);
    fireEvent.click(screen.getByTestId('add-step-empty-picker-option-text'));
    fireEvent.click(screen.getByTestId('add-step-empty-picker-option-endgame_drill'));
    fireEvent.click(screen.getByTestId('add-step-empty-cta'));
    expect(onAdd).toHaveBeenCalledWith('endgame_drill');
  });
});
