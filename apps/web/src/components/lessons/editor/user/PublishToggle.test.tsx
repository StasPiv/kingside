import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../../../test/test-utils';
import { PublishToggle } from './PublishToggle';

describe('<PublishToggle>', () => {
  it('isPublic=false → checkbox unchecked, label «Public», hint «Only you»', () => {
    renderWithProviders(<PublishToggle isPublic={false} onChange={vi.fn()} />);
    const toggle = screen.getByTestId('publish-toggle');
    expect(toggle.getAttribute('data-is-public')).toBe('false');
    expect(
      (screen.getByTestId('publish-toggle-input') as HTMLInputElement).checked,
    ).toBe(false);
    // KS-1916: label всегда «Public» — соответствует полю БД isPublic.
    expect(toggle.textContent).toMatch(/Public/);
    expect(toggle.textContent).not.toMatch(/Private/);
    expect(screen.getByTestId('publish-toggle-hint').textContent).toMatch(
      /Only you/i,
    );
  });

  it('isPublic=true → checkbox checked, label «Public», hint «everyone»', () => {
    renderWithProviders(<PublishToggle isPublic={true} onChange={vi.fn()} />);
    const toggle = screen.getByTestId('publish-toggle');
    expect(toggle.getAttribute('data-is-public')).toBe('true');
    expect(
      (screen.getByTestId('publish-toggle-input') as HTMLInputElement).checked,
    ).toBe(true);
    expect(toggle.textContent).toMatch(/Public/);
    expect(screen.getByTestId('publish-toggle-hint').textContent).toMatch(
      /everyone/i,
    );
  });

  /**
   * KS-1916 (P0): тогл должен быть направлен на ту же сторону что
   * поле БД `isPublic`. Клик по unchecked = делаем публичным
   * (`onChange(true)`); клик по checked = снимаем публичность
   * (`onChange(false)`). Раньше label «Private» при unchecked и
   * «Public» при checked создавал семантическую инверсию.
   */
  it('KS-1916: клик по unchecked checkbox → onChange(true) (делаем публичным)', () => {
    const onChange = vi.fn();
    renderWithProviders(<PublishToggle isPublic={false} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('publish-toggle-input'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('KS-1916: клик по checked checkbox → onChange(false) (делаем приватным)', () => {
    const onChange = vi.fn();
    renderWithProviders(<PublishToggle isPublic={true} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('publish-toggle-input'));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('busy=true → input disabled', () => {
    renderWithProviders(
      <PublishToggle isPublic={false} onChange={vi.fn()} busy />,
    );
    expect(
      (screen.getByTestId('publish-toggle-input') as HTMLInputElement).disabled,
    ).toBe(true);
  });
});
