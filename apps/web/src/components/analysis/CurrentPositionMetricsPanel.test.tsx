/**
 * KS-4033. Тесты вкладки «Метрики» (текущая позиция).
 *
 * Не запускаем реальный WASM (`evalTrace`), вместо этого передаём
 * готовые подкомпоненты через `metricsOverride`.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PositionalSubterm } from '@kingside/shared';
import { CurrentPositionMetricsPanel } from './CurrentPositionMetricsPanel';
import type { CurrentPositionMetricsState } from '../../hooks/useCurrentPositionMetrics';

function sub(
  id: string,
  color: 'w' | 'b' | undefined,
  value_mg: number,
  value_eg: number,
): PositionalSubterm {
  return {
    id: id as PositionalSubterm['id'],
    color,
    square: undefined,
    value_mg,
    value_eg,
  } as PositionalSubterm;
}

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function readyOverride(
  subterms: PositionalSubterm[],
): CurrentPositionMetricsState {
  return {
    status: 'ready',
    subterms,
    fenForSubterms: STARTING_FEN,
    error: null,
  };
}

describe('<CurrentPositionMetricsPanel> KS-4033', () => {
  it('рендерит строки метрик, сортируя по убыванию |diff|', () => {
    const subterms: PositionalSubterm[] = [
      sub('pawn_connected', 'w', 2, 2), // diff=2
      sub('mobility_knight', 'w', 50, 50), // diff=50
      sub('threat_hanging', 'b', 10, 10), // diff=-10 → |10|
    ];
    render(
      <CurrentPositionMetricsPanel
        fen={STARTING_FEN}
        metricsOverride={readyOverride(subterms)}
      />,
    );
    const rows = screen.getAllByTestId(/current-metrics-row-(?!.*value)/);
    // Первой строкой — самая весомая (mobility_knight).
    expect(rows[0]).toHaveAttribute(
      'data-testid',
      'current-metrics-row-mobility_knight',
    );
    expect(rows[1]).toHaveAttribute(
      'data-testid',
      'current-metrics-row-threat_hanging',
    );
    expect(rows[2]).toHaveAttribute(
      'data-testid',
      'current-metrics-row-pawn_connected',
    );
  });

  it('режим «Разница» показывает один столбик со знаком', () => {
    const subterms: PositionalSubterm[] = [
      sub('mobility_knight', 'w', 50, 50),
    ];
    render(
      <CurrentPositionMetricsPanel
        fen={STARTING_FEN}
        metricsOverride={readyOverride(subterms)}
      />,
    );
    expect(
      screen.getByTestId('current-metrics-row-value-mobility_knight'),
    ).toHaveTextContent('+50.0');
  });

  it('переключение режима «Разница ↔ Параллельно» меняет вид без перерасчёта', () => {
    const subterms: PositionalSubterm[] = [
      sub('mobility_knight', 'w', 50, 50),
      sub('mobility_knight', 'b', 20, 20),
    ];
    render(
      <CurrentPositionMetricsPanel
        fen={STARTING_FEN}
        metricsOverride={readyOverride(subterms)}
      />,
    );
    // По умолчанию — режим diff (один value).
    expect(
      screen.queryByTestId('current-metrics-row-white-mobility_knight'),
    ).toBeNull();
    // Переключаемся в parallel.
    fireEvent.click(screen.getByTestId('current-metrics-mode-parallel'));
    expect(
      screen.getByTestId('current-metrics-row-white-mobility_knight'),
    ).toHaveTextContent('50.0');
    expect(
      screen.getByTestId('current-metrics-row-black-mobility_knight'),
    ).toHaveTextContent('20.0');
  });

  it('фильтр «Скрыть малозначимые» убирает строки с |diff| < 1', () => {
    const subterms: PositionalSubterm[] = [
      sub('mobility_knight', 'w', 50, 50), // |diff|=50
      sub('pawn_connected', 'w', 0.5, 0.5), // |diff|=0.5
    ];
    render(
      <CurrentPositionMetricsPanel
        fen={STARTING_FEN}
        metricsOverride={readyOverride(subterms)}
      />,
    );
    expect(
      screen.getByTestId('current-metrics-row-pawn_connected'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('current-metrics-hide-tiny'));
    expect(
      screen.queryByTestId('current-metrics-row-pawn_connected'),
    ).toBeNull();
    expect(
      screen.getByTestId('current-metrics-row-mobility_knight'),
    ).toBeInTheDocument();
  });

  it('состояние loading показывает заглушку, когда данных ещё нет', () => {
    render(
      <CurrentPositionMetricsPanel
        fen={STARTING_FEN}
        metricsOverride={{
          status: 'loading',
          subterms: null,
          fenForSubterms: null,
          error: null,
        }}
      />,
    );
    expect(
      screen.getByTestId('current-metrics-loading'),
    ).toBeInTheDocument();
  });

  it('состояние error показывает текст ошибки', () => {
    render(
      <CurrentPositionMetricsPanel
        fen={STARTING_FEN}
        metricsOverride={{
          status: 'error',
          subterms: null,
          fenForSubterms: null,
          error: 'wasm crash',
        }}
      />,
    );
    expect(screen.getByTestId('current-metrics-error')).toHaveTextContent(
      'wasm crash',
    );
  });

  it('headerLink рендерится когда передан', () => {
    render(
      <CurrentPositionMetricsPanel
        fen={STARTING_FEN}
        metricsOverride={readyOverride([])}
        headerLink={{ label: '↗ Полная аналитика', href: '/analyses/x/metrics' }}
      />,
    );
    const a = screen.getByTestId('current-metrics-header-link');
    expect(a).toHaveAttribute('href', '/analyses/x/metrics');
    expect(a).toHaveTextContent('↗ Полная аналитика');
  });
});
