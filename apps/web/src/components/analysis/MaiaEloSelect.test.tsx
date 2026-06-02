/**
 * KS-3588. Тесты `MaiaEloSelect`: 14 опций, onChange, error-иконка.
 */
import { describe, it, expect, vi } from 'vitest';
import { act } from '@testing-library/react';

import { MaiaEloSelect } from './MaiaEloSelect';
import { renderWithProviders, screen } from '../../test/test-utils';

describe('<MaiaEloSelect> KS-3588', () => {
  it('рендерит 14 опций (1100..2400 шаг 100)', () => {
    renderWithProviders(
      <MaiaEloSelect value={1500} onChange={vi.fn()} status="ready" />,
    );
    const select = screen.getByTestId(
      'maia-elo-select-input',
    ) as HTMLSelectElement;
    expect(select.options).toHaveLength(14);
    expect(select.options[0].value).toBe('1100');
    expect(select.options[13].value).toBe('2400');
    expect(select.value).toBe('1500');
  });

  it('onChange зовётся с числом при смене value', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <MaiaEloSelect value={1500} onChange={onChange} status="ready" />,
    );
    const select = screen.getByTestId(
      'maia-elo-select-input',
    ) as HTMLSelectElement;
    act(() => {
      select.value = '2000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(2000);
  });

  it('status=error → показывается иконка-предупреждение с tooltip', () => {
    renderWithProviders(
      <MaiaEloSelect value={1500} onChange={vi.fn()} status="error" />,
    );
    const warn = screen.getByTestId('maia-elo-select-warning');
    expect(warn).toBeTruthy();
    expect(warn.getAttribute('title')?.toLowerCase()).toContain('maia');
  });

  it('status≠error → иконка-предупреждение скрыта', () => {
    renderWithProviders(
      <MaiaEloSelect value={1500} onChange={vi.fn()} status="ready" />,
    );
    expect(screen.queryByTestId('maia-elo-select-warning')).toBeNull();
  });

  it('контейнер несёт data-status для CSS-хуков', () => {
    renderWithProviders(
      <MaiaEloSelect value={1500} onChange={vi.fn()} status="loading" />,
    );
    const root = screen.getByTestId('maia-elo-select');
    expect(root.getAttribute('data-status')).toBe('loading');
  });
});
