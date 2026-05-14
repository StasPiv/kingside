/**
 * KS-3004 (ADR-065 §5.1.2, F3). Тесты `<PrecisionScoreBadge />`.
 *
 * Покрытие:
 *  - количество заполненных звёзд = score для всех 5 значений;
 *  - тон/CSS-класс по §4.2;
 *  - score=null → null-state с «—»;
 *  - не-integer/выход за диапазон зажимаются;
 *  - testIdSuffix корректно прокидывается в data-testid.
 */

import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import { PrecisionScoreBadge } from './PrecisionScoreBadge';

const TONES: Array<{ score: 1 | 2 | 3 | 4 | 5; tone: string }> = [
  { score: 5, tone: 'emerald' },
  { score: 4, tone: 'lime' },
  { score: 3, tone: 'amber' },
  { score: 2, tone: 'orange' },
  { score: 1, tone: 'red' },
];

describe('<PrecisionScoreBadge>', () => {
  it.each(TONES)('score=$score → $tone, заполнено $score звёзд', ({ score, tone }) => {
    renderWithProviders(<PrecisionScoreBadge score={score} />);
    const badge = screen.getByTestId('precision-score-badge');
    expect(badge.getAttribute('data-tone')).toBe(tone);
    expect(badge.getAttribute('data-score')).toBe(String(score));
    expect(badge.className).toContain(`precision-score-badge--${tone}`);

    const stars = badge.querySelectorAll('svg');
    expect(stars).toHaveLength(5);
    let filled = 0;
    stars.forEach((s) => {
      if (s.getAttribute('data-filled') === 'true') filled += 1;
    });
    expect(filled).toBe(score);
  });

  it('score=null → null-state, "—" вместо звёзд', () => {
    renderWithProviders(<PrecisionScoreBadge score={null} />);
    const badge = screen.getByTestId('precision-score-badge');
    expect(badge.getAttribute('data-tone')).toBe('unavailable');
    expect(badge.className).toContain('precision-score-badge--unavailable');
    expect(badge.querySelector('svg')).toBeNull();
    expect(badge.textContent).toContain('—');
  });

  it('score=10 зажимается до 5; score=0 → 1; score=2.6 → 3', () => {
    const { rerender } = renderWithProviders(<PrecisionScoreBadge score={10} />);
    expect(
      screen.getByTestId('precision-score-badge').getAttribute('data-score'),
    ).toBe('5');

    rerender(<PrecisionScoreBadge score={0} />);
    expect(
      screen.getByTestId('precision-score-badge').getAttribute('data-score'),
    ).toBe('1');

    rerender(<PrecisionScoreBadge score={2.6} />);
    expect(
      screen.getByTestId('precision-score-badge').getAttribute('data-score'),
    ).toBe('3');
  });

  it('testIdSuffix прокидывается в data-testid', () => {
    renderWithProviders(
      <PrecisionScoreBadge score={4} testIdSuffix="abc-123" />,
    );
    expect(screen.getByTestId('precision-score-badge-abc-123')).toBeTruthy();
  });

  it('aria-label содержит score и "5"', () => {
    renderWithProviders(<PrecisionScoreBadge score={3} />);
    const badge = screen.getByTestId('precision-score-badge');
    expect(badge.getAttribute('aria-label')).toContain('3');
    expect(badge.getAttribute('aria-label')).toContain('5');
  });
});
