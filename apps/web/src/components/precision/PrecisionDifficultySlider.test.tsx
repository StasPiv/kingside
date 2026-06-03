/**
 * KS-3654 → KS-3657 / ADR-106 §2.6. Тесты `<PrecisionDifficultySlider />`.
 *
 * Покрытие:
 *  - uncontrolled-режим: начальное значение читается через
 *    `readPrecisionMaiaThreshold()`;
 *  - controlled-режим: `value` из пропсов = source-of-truth, внутренний
 *    state игнорируется;
 *  - смена → запись в `localStorage.precision.maiaThreshold`;
 *  - смена → вызов `onChange` с округлённым значением;
 *  - подсказка «Найдено: N» / «Найдено: N+» по `loadedCount` + `hasMore`;
 *  - подсказка скрыта без `loadedCount`;
 *  - метка меняется по диапазонам (Все / Сложные / Эксперт).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { useState } from 'react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { PrecisionDifficultySlider } from './PrecisionDifficultySlider';
import {
  PRECISION_MAIA_DEFAULT_THRESHOLD,
  PRECISION_MAIA_THRESHOLD_STORAGE_KEY,
} from '../../config/precisionMaiaThreshold';

beforeEach(() => {
  localStorage.removeItem(PRECISION_MAIA_THRESHOLD_STORAGE_KEY);
});

describe('<PrecisionDifficultySlider /> — uncontrolled-режим (legacy)', () => {
  it('начальное значение — из localStorage (если есть)', () => {
    localStorage.setItem(PRECISION_MAIA_THRESHOLD_STORAGE_KEY, '0.5');
    renderWithProviders(<PrecisionDifficultySlider />);
    const input = screen.getByTestId(
      'precision-difficulty-filter-input',
    ) as HTMLInputElement;
    expect(input.value).toBe('0.5');
  });

  it('начальное значение — PRECISION_MAIA_DEFAULT_THRESHOLD при пустом localStorage', () => {
    renderWithProviders(<PrecisionDifficultySlider />);
    const input = screen.getByTestId(
      'precision-difficulty-filter-input',
    ) as HTMLInputElement;
    expect(parseFloat(input.value)).toBe(PRECISION_MAIA_DEFAULT_THRESHOLD);
  });

  it('смена значения пишется в localStorage', () => {
    renderWithProviders(<PrecisionDifficultySlider />);
    const input = screen.getByTestId(
      'precision-difficulty-filter-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.7' } });
    expect(localStorage.getItem(PRECISION_MAIA_THRESHOLD_STORAGE_KEY)).toBe(
      '0.70',
    );
  });
});

describe('<PrecisionDifficultySlider /> — controlled-режим (KS-3657)', () => {
  function Wrapper({
    initial = PRECISION_MAIA_DEFAULT_THRESHOLD,
    onChangeSpy,
  }: {
    initial?: number;
    onChangeSpy?: (v: number) => void;
  }) {
    const [value, setValue] = useState(initial);
    return (
      <PrecisionDifficultySlider
        value={value}
        onChange={(v) => {
          setValue(v);
          onChangeSpy?.(v);
        }}
      />
    );
  }

  it('value из пропсов = source-of-truth (localStorage игнорируется)', () => {
    localStorage.setItem(PRECISION_MAIA_THRESHOLD_STORAGE_KEY, '0.9');
    renderWithProviders(<Wrapper initial={0.2} />);
    const input = screen.getByTestId(
      'precision-difficulty-filter-input',
    ) as HTMLInputElement;
    expect(input.value).toBe('0.2');
  });

  it('смена → onChange с округлённым значением + запись в localStorage', () => {
    const spy: number[] = [];
    renderWithProviders(<Wrapper onChangeSpy={(v) => spy.push(v)} />);
    const input = screen.getByTestId(
      'precision-difficulty-filter-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.6' } });
    expect(spy.at(-1)).toBeCloseTo(0.6, 5);
    expect(localStorage.getItem(PRECISION_MAIA_THRESHOLD_STORAGE_KEY)).toBe(
      '0.60',
    );
  });
});

describe('<PrecisionDifficultySlider /> — подсказка "Найдено"', () => {
  it('loadedCount задан, hasMore=false → "Найдено: N"', () => {
    renderWithProviders(
      <PrecisionDifficultySlider loadedCount={5} hasMore={false} />,
    );
    const hint = screen.getByTestId('precision-difficulty-filter-hint');
    expect(hint.textContent).toContain('5');
    expect(hint.textContent).not.toContain('+');
  });

  it('loadedCount задан, hasMore=true → "Найдено: N+"', () => {
    renderWithProviders(
      <PrecisionDifficultySlider loadedCount={20} hasMore={true} />,
    );
    const hint = screen.getByTestId('precision-difficulty-filter-hint');
    expect(hint.textContent).toContain('20');
    expect(hint.textContent).toContain('+');
  });

  it('loadedCount === 0 (пустая выдача) → подсказка показывается с 0', () => {
    renderWithProviders(
      <PrecisionDifficultySlider loadedCount={0} hasMore={false} />,
    );
    const hint = screen.getByTestId('precision-difficulty-filter-hint');
    expect(hint.textContent).toContain('0');
  });

  it('подсказка скрыта, если loadedCount не передан', () => {
    renderWithProviders(<PrecisionDifficultySlider />);
    expect(
      screen.queryByTestId('precision-difficulty-filter-hint'),
    ).toBeNull();
  });
});

describe('<PrecisionDifficultySlider /> — текстовая метка', () => {
  it('value меняет текстовую метку (Все / Сложные / Эксперт)', () => {
    renderWithProviders(<PrecisionDifficultySlider />);
    const input = screen.getByTestId(
      'precision-difficulty-filter-input',
    ) as HTMLInputElement;
    const valueLabel = screen.getByTestId(
      'precision-difficulty-filter-value',
    );
    fireEvent.change(input, { target: { value: '0' } });
    expect(valueLabel.textContent).toMatch(/Все|All/i);
    fireEvent.change(input, { target: { value: '0.6' } });
    expect(valueLabel.textContent).toMatch(/Сложные|Hard/i);
    fireEvent.change(input, { target: { value: '0.85' } });
    expect(valueLabel.textContent).toMatch(/Эксперт|Expert/i);
  });
});
