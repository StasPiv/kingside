/**
 * KS-3660 / ADR-106 §2.6. Тесты `<PrecisionPuzzleDifficulty />`.
 *
 * Покрытие:
 *  - валидное значение → процент 0..100 (`0.42` → `42%`, `0` → `0%`, `1` → `100%`);
 *  - округление до целого (`0.426` → `43%`);
 *  - `null` / `undefined` → не отрисовывается;
 *  - устаревшая / отсутствующая `maiaMetricVersion` → не отрисовывается;
 *  - NaN / Infinity → не отрисовывается.
 */
import { describe, it, expect } from 'vitest';

import { renderWithProviders, screen } from '../../test/test-utils';
import { PrecisionPuzzleDifficulty } from './PrecisionPuzzleDifficulty';
import { MAIA_METRIC_VERSION } from '../../config/precisionMaiaThreshold';

describe('<PrecisionPuzzleDifficulty />', () => {
  it('prob=0.42 + актуальная версия → "42%"', () => {
    renderWithProviders(
      <PrecisionPuzzleDifficulty
        maiaWeakChoiceProb={0.42}
        maiaMetricVersion={MAIA_METRIC_VERSION}
      />,
    );
    const value = screen.getByTestId('precision-puzzle-difficulty-value');
    expect(value.textContent).toBe('42%');
  });

  it('prob=0 → "0%"', () => {
    renderWithProviders(
      <PrecisionPuzzleDifficulty
        maiaWeakChoiceProb={0}
        maiaMetricVersion={MAIA_METRIC_VERSION}
      />,
    );
    expect(
      screen.getByTestId('precision-puzzle-difficulty-value').textContent,
    ).toBe('0%');
  });

  it('prob=1 → "100%"', () => {
    renderWithProviders(
      <PrecisionPuzzleDifficulty
        maiaWeakChoiceProb={1}
        maiaMetricVersion={MAIA_METRIC_VERSION}
      />,
    );
    expect(
      screen.getByTestId('precision-puzzle-difficulty-value').textContent,
    ).toBe('100%');
  });

  it('prob=0.426 → "43%" (округление вверх по Math.round)', () => {
    renderWithProviders(
      <PrecisionPuzzleDifficulty
        maiaWeakChoiceProb={0.426}
        maiaMetricVersion={MAIA_METRIC_VERSION}
      />,
    );
    expect(
      screen.getByTestId('precision-puzzle-difficulty-value').textContent,
    ).toBe('43%');
  });

  it('prob=null → компонент не отрисован', () => {
    renderWithProviders(
      <PrecisionPuzzleDifficulty
        maiaWeakChoiceProb={null}
        maiaMetricVersion={MAIA_METRIC_VERSION}
      />,
    );
    expect(screen.queryByTestId('precision-puzzle-difficulty')).toBeNull();
  });

  it('prob=undefined → компонент не отрисован', () => {
    renderWithProviders(
      <PrecisionPuzzleDifficulty
        maiaMetricVersion={MAIA_METRIC_VERSION}
      />,
    );
    expect(screen.queryByTestId('precision-puzzle-difficulty')).toBeNull();
  });

  it('устаревшая maiaMetricVersion → компонент не отрисован', () => {
    renderWithProviders(
      <PrecisionPuzzleDifficulty
        maiaWeakChoiceProb={0.5}
        maiaMetricVersion={MAIA_METRIC_VERSION + 1}
      />,
    );
    expect(screen.queryByTestId('precision-puzzle-difficulty')).toBeNull();
  });

  it('maiaMetricVersion=null → компонент не отрисован', () => {
    renderWithProviders(
      <PrecisionPuzzleDifficulty
        maiaWeakChoiceProb={0.5}
        maiaMetricVersion={null}
      />,
    );
    expect(screen.queryByTestId('precision-puzzle-difficulty')).toBeNull();
  });

  it('NaN → не отрисован', () => {
    renderWithProviders(
      <PrecisionPuzzleDifficulty
        maiaWeakChoiceProb={NaN}
        maiaMetricVersion={MAIA_METRIC_VERSION}
      />,
    );
    expect(screen.queryByTestId('precision-puzzle-difficulty')).toBeNull();
  });

  it('Infinity → не отрисован', () => {
    renderWithProviders(
      <PrecisionPuzzleDifficulty
        maiaWeakChoiceProb={Infinity}
        maiaMetricVersion={MAIA_METRIC_VERSION}
      />,
    );
    expect(screen.queryByTestId('precision-puzzle-difficulty')).toBeNull();
  });
});
