/**
 * KS-3654 / ADR-106 §2.6. Тесты `<PrecisionDifficultySlider />`.
 *
 * Покрытие:
 *  - начальное значение читается через `readPrecisionMaiaThreshold()`;
 *  - смена → запись в localStorage `precision.maiaThreshold`;
 *  - смена → вызов `onChange` с округлённым значением;
 *  - порог 0 → 100% выборки проходит;
 *  - порог 1 → проходят только пазлы с `prob === 1` или без актуальной
 *    `maiaMetricVersion` (safe fallback);
 *  - подсказка с процентом не отображается при пустой/не переданной
 *    выборке.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { PrecisionDifficultySlider } from './PrecisionDifficultySlider';
import {
  MAIA_METRIC_VERSION,
  PRECISION_MAIA_DEFAULT_THRESHOLD,
  PRECISION_MAIA_THRESHOLD_STORAGE_KEY,
} from '../../config/precisionMaiaThreshold';

beforeEach(() => {
  localStorage.removeItem(PRECISION_MAIA_THRESHOLD_STORAGE_KEY);
});

describe('<PrecisionDifficultySlider />', () => {
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

  it('onChange вызывается с округлённым по шагу значением', () => {
    const calls: number[] = [];
    renderWithProviders(
      <PrecisionDifficultySlider onChange={(v) => calls.push(v)} />,
    );
    const input = screen.getByTestId(
      'precision-difficulty-filter-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.6' } });
    expect(calls.at(-1)).toBeCloseTo(0.6, 5);
  });

  it('порог 0 → 100% выборки проходит (подсказка "Доступно ≈ 100% выборки")', () => {
    localStorage.setItem(PRECISION_MAIA_THRESHOLD_STORAGE_KEY, '0');
    const sample = [
      { maiaWeakChoiceProb: 0.1, maiaMetricVersion: MAIA_METRIC_VERSION },
      { maiaWeakChoiceProb: 0.5, maiaMetricVersion: MAIA_METRIC_VERSION },
      { maiaWeakChoiceProb: 0.9, maiaMetricVersion: MAIA_METRIC_VERSION },
    ];
    renderWithProviders(
      <PrecisionDifficultySlider puzzlesSample={sample} />,
    );
    const hint = screen.getByTestId('precision-difficulty-filter-hint');
    expect(hint.textContent).toContain('100');
  });

  it('порог 1 → проходят только prob=1 или пазлы без актуальной maiaMetricVersion', () => {
    localStorage.setItem(PRECISION_MAIA_THRESHOLD_STORAGE_KEY, '1');
    const sample = [
      // Не проходит (актуальная версия, prob < 1).
      { maiaWeakChoiceProb: 0.9, maiaMetricVersion: MAIA_METRIC_VERSION },
      // Проходит (актуальная версия, prob = 1).
      { maiaWeakChoiceProb: 1, maiaMetricVersion: MAIA_METRIC_VERSION },
      // Проходит (не размечен — safe fallback).
      { maiaWeakChoiceProb: null, maiaMetricVersion: null },
      // Проходит (устаревшая версия — safe fallback).
      {
        maiaWeakChoiceProb: 0.1,
        maiaMetricVersion: MAIA_METRIC_VERSION + 1,
      },
    ];
    renderWithProviders(
      <PrecisionDifficultySlider puzzlesSample={sample} />,
    );
    const hint = screen.getByTestId('precision-difficulty-filter-hint');
    // 3 из 4 = 75%.
    expect(hint.textContent).toContain('75');
  });

  it('подсказка не отображается без puzzlesSample', () => {
    renderWithProviders(<PrecisionDifficultySlider />);
    expect(
      screen.queryByTestId('precision-difficulty-filter-hint'),
    ).toBeNull();
  });

  it('подсказка не отображается при пустой выборке', () => {
    renderWithProviders(<PrecisionDifficultySlider puzzlesSample={[]} />);
    expect(
      screen.queryByTestId('precision-difficulty-filter-hint'),
    ).toBeNull();
  });

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
