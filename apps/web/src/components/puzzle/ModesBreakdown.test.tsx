/**
 * KS-2495 — тесты `<ModesBreakdown>`. Проверяем что рендерятся обе
 * карточки с правильными ссылками и метриками.
 */
import { describe, it, expect } from 'vitest';
import type { PuzzleStatsByMode } from '@kingside/shared';

import { renderWithProviders, screen } from '../../test/test-utils';
import { ModesBreakdown } from './ModesBreakdown';

function buildByMode(over: Partial<PuzzleStatsByMode> = {}): PuzzleStatsByMode {
  return {
    'forced-line': {
      attempts: 50,
      solved: 32,
      accuracy: 64,
      avgRating: 1620,
      avgTimeMs: 18000,
    },
    'play-vs-engine': {
      attempts: 0,
      solved: 0,
      accuracy: 0,
      avgRating: null,
      avgTimeMs: 0,
    },
    ...over,
  };
}

describe('<ModesBreakdown> KS-2495', () => {
  it('рендерит обе карточки с правильными ссылками', () => {
    renderWithProviders(<ModesBreakdown byMode={buildByMode()} />);
    expect(screen.getByTestId('modes-breakdown')).toBeInTheDocument();
    const fl = screen.getByTestId('modes-breakdown-card-forced-line');
    expect(fl.getAttribute('href')).toBe('/puzzles');
    expect(fl.getAttribute('data-mode')).toBe('forced-line');
    const pve = screen.getByTestId('modes-breakdown-card-play-vs-engine');
    expect(pve.getAttribute('href')).toBe('/precision');
    expect(pve.getAttribute('data-mode')).toBe('play-vs-engine');
  });

  it('forced-line: метрики выводятся числом + accuracy с %', () => {
    renderWithProviders(<ModesBreakdown byMode={buildByMode()} />);
    expect(
      screen.getByTestId('modes-breakdown-forced-line-attempts'),
    ).toHaveTextContent('50');
    expect(
      screen.getByTestId('modes-breakdown-forced-line-solved'),
    ).toHaveTextContent('32');
    expect(
      screen.getByTestId('modes-breakdown-forced-line-accuracy'),
    ).toHaveTextContent('64%');
    expect(
      screen.getByTestId('modes-breakdown-forced-line-avgRating'),
    ).toHaveTextContent('1620');
  });

  it('play-vs-engine c attempts=0 → accuracy и avgRating «—», числовые поля 0', () => {
    renderWithProviders(<ModesBreakdown byMode={buildByMode()} />);
    expect(
      screen.getByTestId('modes-breakdown-play-vs-engine-attempts'),
    ).toHaveTextContent('0');
    expect(
      screen.getByTestId('modes-breakdown-play-vs-engine-solved'),
    ).toHaveTextContent('0');
    // attempts=0 → дробит accuracy в прочерк (нет смысла показывать 0%).
    expect(
      screen.getByTestId('modes-breakdown-play-vs-engine-accuracy'),
    ).toHaveTextContent('—');
    // avgRating=null → прочерк.
    expect(
      screen.getByTestId('modes-breakdown-play-vs-engine-avgRating'),
    ).toHaveTextContent('—');
  });

  it('play-vs-engine с реальными метриками рендерится корректно', () => {
    renderWithProviders(
      <ModesBreakdown
        byMode={buildByMode({
          'play-vs-engine': {
            attempts: 12,
            solved: 7,
            accuracy: 58,
            avgRating: 1980,
            avgTimeMs: 32000,
          },
        })}
      />,
    );
    expect(
      screen.getByTestId('modes-breakdown-play-vs-engine-attempts'),
    ).toHaveTextContent('12');
    expect(
      screen.getByTestId('modes-breakdown-play-vs-engine-accuracy'),
    ).toHaveTextContent('58%');
    expect(
      screen.getByTestId('modes-breakdown-play-vs-engine-avgRating'),
    ).toHaveTextContent('1980');
  });

  it('заголовок и CTA не fallback на ключ (i18n работает)', () => {
    renderWithProviders(<ModesBreakdown byMode={buildByMode()} />);
    const root = screen.getByTestId('modes-breakdown');
    expect(root.textContent).not.toContain('puzzleStats.modes.heading');
    expect(root.textContent).toMatch(/Modes breakdown|Режимы решения/);
    expect(root.textContent).toMatch(/Train|Тренировать/);
  });
});
