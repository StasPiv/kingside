/**
 * KS-3654 → KS-3657 → KS-3665 / ADR-106 §2.6. Тесты
 * `<PrecisionDifficultySlider />`.
 *
 * Покрытие:
 *  - uncontrolled-режим: начальное значение читается через
 *    `readPrecisionMaiaRange()`;
 *  - controlled-режим: `value` из пропсов = source-of-truth, внутренний
 *    state игнорируется;
 *  - смена нижней / верхней границы → запись в localStorage (новый
 *    range-ключ + legacy single-key для обратной совместимости);
 *  - смена → вызов `onChange` с корректным `{min, max}` объектом;
 *  - clamp: нижняя граница не может превысить верхнюю и наоборот;
 *  - подсказка «Найдено: N» / «Найдено: N+» по `loadedCount` + `hasMore`;
 *  - подсказка скрыта без `loadedCount`;
 *  - подпись значения отображает оба процента (например, «30% – 100%»).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { useState } from 'react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { PrecisionDifficultySlider } from './PrecisionDifficultySlider';
import {
  PRECISION_MAIA_DEFAULT_RANGE,
  PRECISION_MAIA_RANGE_STORAGE_KEY,
  PRECISION_MAIA_THRESHOLD_STORAGE_KEY,
  PrecisionMaiaRange,
} from '../../config/precisionMaiaThreshold';

beforeEach(() => {
  localStorage.removeItem(PRECISION_MAIA_RANGE_STORAGE_KEY);
  localStorage.removeItem(PRECISION_MAIA_THRESHOLD_STORAGE_KEY);
});

describe('<PrecisionDifficultySlider /> — uncontrolled-режим (legacy)', () => {
  it('начальное значение — из range-ключа localStorage (если есть)', () => {
    localStorage.setItem(
      PRECISION_MAIA_RANGE_STORAGE_KEY,
      JSON.stringify({ min: 0.4, max: 0.7 }),
    );
    renderWithProviders(<PrecisionDifficultySlider />);
    const min = screen.getByTestId(
      'precision-difficulty-filter-min',
    ) as HTMLInputElement;
    const max = screen.getByTestId(
      'precision-difficulty-filter-max',
    ) as HTMLInputElement;
    expect(min.value).toBe('0.4');
    expect(max.value).toBe('0.7');
  });

  it('начальное значение — дефолтный range при пустом localStorage', () => {
    renderWithProviders(<PrecisionDifficultySlider />);
    const min = screen.getByTestId(
      'precision-difficulty-filter-min',
    ) as HTMLInputElement;
    const max = screen.getByTestId(
      'precision-difficulty-filter-max',
    ) as HTMLInputElement;
    expect(parseFloat(min.value)).toBe(PRECISION_MAIA_DEFAULT_RANGE.min);
    expect(parseFloat(max.value)).toBe(PRECISION_MAIA_DEFAULT_RANGE.max);
  });

  it('смена нижней границы пишется в оба ключа localStorage', () => {
    renderWithProviders(<PrecisionDifficultySlider />);
    const min = screen.getByTestId(
      'precision-difficulty-filter-min',
    ) as HTMLInputElement;
    fireEvent.change(min, { target: { value: '0.5' } });
    const range = JSON.parse(
      localStorage.getItem(PRECISION_MAIA_RANGE_STORAGE_KEY) || '{}',
    );
    expect(range.min).toBeCloseTo(0.5, 5);
    expect(range.max).toBe(1);
    // Legacy single-key дублирует min — для pickEligiblePrecisionPuzzle.
    expect(localStorage.getItem(PRECISION_MAIA_THRESHOLD_STORAGE_KEY)).toBe(
      '0.50',
    );
  });

  it('смена верхней границы пишется в range-ключ, не меняет legacy-min', () => {
    renderWithProviders(<PrecisionDifficultySlider />);
    const max = screen.getByTestId(
      'precision-difficulty-filter-max',
    ) as HTMLInputElement;
    fireEvent.change(max, { target: { value: '0.7' } });
    const range = JSON.parse(
      localStorage.getItem(PRECISION_MAIA_RANGE_STORAGE_KEY) || '{}',
    );
    expect(range.min).toBeCloseTo(PRECISION_MAIA_DEFAULT_RANGE.min, 5);
    expect(range.max).toBeCloseTo(0.7, 5);
    // Legacy ключ хранит min — он не должен подскочить из-за смены max.
    expect(localStorage.getItem(PRECISION_MAIA_THRESHOLD_STORAGE_KEY)).toBe(
      PRECISION_MAIA_DEFAULT_RANGE.min.toFixed(2),
    );
  });
});

describe('<PrecisionDifficultySlider /> — controlled-режим (KS-3665)', () => {
  function Wrapper({
    initial = PRECISION_MAIA_DEFAULT_RANGE,
    onChangeSpy,
  }: {
    initial?: PrecisionMaiaRange;
    onChangeSpy?: (v: PrecisionMaiaRange) => void;
  }) {
    const [value, setValue] = useState<PrecisionMaiaRange>(initial);
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
    localStorage.setItem(
      PRECISION_MAIA_RANGE_STORAGE_KEY,
      JSON.stringify({ min: 0.9, max: 1 }),
    );
    renderWithProviders(<Wrapper initial={{ min: 0.2, max: 0.5 }} />);
    const min = screen.getByTestId(
      'precision-difficulty-filter-min',
    ) as HTMLInputElement;
    const max = screen.getByTestId(
      'precision-difficulty-filter-max',
    ) as HTMLInputElement;
    expect(min.value).toBe('0.2');
    expect(max.value).toBe('0.5');
  });

  it('смена min → onChange с новым диапазоном + запись в localStorage', () => {
    const spy: PrecisionMaiaRange[] = [];
    renderWithProviders(<Wrapper onChangeSpy={(v) => spy.push(v)} />);
    const min = screen.getByTestId(
      'precision-difficulty-filter-min',
    ) as HTMLInputElement;
    fireEvent.change(min, { target: { value: '0.6' } });
    const last = spy.at(-1)!;
    expect(last.min).toBeCloseTo(0.6, 5);
    expect(last.max).toBe(PRECISION_MAIA_DEFAULT_RANGE.max);
    expect(localStorage.getItem(PRECISION_MAIA_THRESHOLD_STORAGE_KEY)).toBe(
      '0.60',
    );
  });

  it('min нельзя поднять выше max — clamp к max', () => {
    const spy: PrecisionMaiaRange[] = [];
    renderWithProviders(
      <Wrapper
        initial={{ min: 0.2, max: 0.5 }}
        onChangeSpy={(v) => spy.push(v)}
      />,
    );
    const min = screen.getByTestId(
      'precision-difficulty-filter-min',
    ) as HTMLInputElement;
    fireEvent.change(min, { target: { value: '0.9' } });
    const last = spy.at(-1)!;
    expect(last.min).toBeCloseTo(0.5, 5);
    expect(last.max).toBeCloseTo(0.5, 5);
  });

  it('max нельзя опустить ниже min — clamp к min', () => {
    const spy: PrecisionMaiaRange[] = [];
    renderWithProviders(
      <Wrapper
        initial={{ min: 0.4, max: 0.8 }}
        onChangeSpy={(v) => spy.push(v)}
      />,
    );
    const max = screen.getByTestId(
      'precision-difficulty-filter-max',
    ) as HTMLInputElement;
    fireEvent.change(max, { target: { value: '0.2' } });
    const last = spy.at(-1)!;
    expect(last.min).toBeCloseTo(0.4, 5);
    expect(last.max).toBeCloseTo(0.4, 5);
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

  it('KS-3672: total задан → "Найдено: N" без плюса (точное число)', () => {
    renderWithProviders(
      <PrecisionDifficultySlider
        loadedCount={20}
        hasMore={true}
        total={137}
      />,
    );
    const hint = screen.getByTestId('precision-difficulty-filter-hint');
    expect(hint.textContent).toContain('137');
    expect(hint.textContent).not.toContain('+');
    expect(hint.textContent).not.toContain('20');
  });

  it('KS-3672: total=0 → "Найдено: 0"', () => {
    renderWithProviders(
      <PrecisionDifficultySlider loadedCount={0} hasMore={false} total={0} />,
    );
    const hint = screen.getByTestId('precision-difficulty-filter-hint');
    expect(hint.textContent).toContain('0');
    expect(hint.textContent).not.toContain('+');
  });

  it('KS-3672: total=null → fallback на loadedCount + hasMore', () => {
    renderWithProviders(
      <PrecisionDifficultySlider
        loadedCount={20}
        hasMore={true}
        total={null}
      />,
    );
    const hint = screen.getByTestId('precision-difficulty-filter-hint');
    expect(hint.textContent).toContain('20');
    expect(hint.textContent).toContain('+');
  });

  it('KS-3672: total=undefined → fallback на loadedCount + hasMore', () => {
    renderWithProviders(
      <PrecisionDifficultySlider loadedCount={20} hasMore={false} />,
    );
    const hint = screen.getByTestId('precision-difficulty-filter-hint');
    expect(hint.textContent).toContain('20');
    expect(hint.textContent).not.toContain('+');
  });
});

describe('<PrecisionDifficultySlider /> — подпись значения', () => {
  it('value меняет подпись (например, "30% – 100%" → "60% – 80%")', () => {
    function W() {
      const [v, setV] = useState<PrecisionMaiaRange>({ min: 0.3, max: 1 });
      return <PrecisionDifficultySlider value={v} onChange={setV} />;
    }
    renderWithProviders(<W />);
    const valueLabel = screen.getByTestId(
      'precision-difficulty-filter-value',
    );
    expect(valueLabel.textContent).toContain('30%');
    expect(valueLabel.textContent).toContain('100%');
    const min = screen.getByTestId(
      'precision-difficulty-filter-min',
    ) as HTMLInputElement;
    const max = screen.getByTestId(
      'precision-difficulty-filter-max',
    ) as HTMLInputElement;
    fireEvent.change(min, { target: { value: '0.6' } });
    fireEvent.change(max, { target: { value: '0.8' } });
    expect(valueLabel.textContent).toContain('60%');
    expect(valueLabel.textContent).toContain('80%');
  });
});
