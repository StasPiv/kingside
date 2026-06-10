/**
 * KS-4033. Тесты вкладки «Метрики» (текущая позиция).
 *
 * Не запускаем реальный WASM (`evalTrace`), вместо этого передаём
 * готовые подкомпоненты через `metricsOverride`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PositionalSubterm } from '@kingside/shared';
import { CurrentPositionMetricsPanel } from './CurrentPositionMetricsPanel';
import type { CurrentPositionMetricsState } from '../../hooks/useCurrentPositionMetrics';

function sub(
  id: string,
  color: 'w' | 'b' | undefined,
  value_mg: number,
  value_eg: number,
  square?: string,
): PositionalSubterm {
  return {
    id: id as PositionalSubterm['id'],
    color,
    square,
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

  it('скрывает строки psqt_* — техническое разложение без шахматной семантики', () => {
    const subterms: PositionalSubterm[] = [
      sub('psqt_pawn', 'w', 90, 70),
      sub('psqt_knight', 'w', 50, 40),
      sub('mobility_knight', 'w', 30, 20),
    ];
    render(
      <CurrentPositionMetricsPanel
        fen={STARTING_FEN}
        metricsOverride={readyOverride(subterms)}
      />,
    );
    expect(screen.queryByTestId('current-metrics-row-psqt_pawn')).toBeNull();
    expect(screen.queryByTestId('current-metrics-row-psqt_knight')).toBeNull();
    expect(
      screen.getByTestId('current-metrics-row-mobility_knight'),
    ).toBeInTheDocument();
  });

  describe('подсветка клеток при клике на строку (KS-4033 follow-up)', () => {
    it('первый клик передаёт squares, повторный — null (toggle)', () => {
      const subterms: PositionalSubterm[] = [
        sub('pawn_isolated', 'w', 5, 5, 'd4'),
        sub('pawn_isolated', 'b', 4, 4, 'h7'),
      ];
      const onHighlight = vi.fn();
      render(
        <CurrentPositionMetricsPanel
          fen={STARTING_FEN}
          metricsOverride={readyOverride(subterms)}
          onHighlightSquares={onHighlight}
        />,
      );
      const row = screen.getByTestId('current-metrics-row-pawn_isolated');
      fireEvent.click(row);
      expect(onHighlight).toHaveBeenLastCalledWith({
        id: 'pawn_isolated',
        squares: { white: ['d4'], black: ['h7'] },
      });
      expect(row).toHaveAttribute('data-selected', 'true');
      fireEvent.click(row);
      expect(onHighlight).toHaveBeenLastCalledWith(null);
      expect(row).toHaveAttribute('data-selected', 'false');
    });

    it('клик по другой строке переключает выделение', () => {
      const subterms: PositionalSubterm[] = [
        sub('pawn_isolated', 'w', 5, 5, 'd4'),
        sub('mobility_knight', 'w', 6, 6, 'f3'),
      ];
      const onHighlight = vi.fn();
      render(
        <CurrentPositionMetricsPanel
          fen={STARTING_FEN}
          metricsOverride={readyOverride(subterms)}
          onHighlightSquares={onHighlight}
        />,
      );
      fireEvent.click(
        screen.getByTestId('current-metrics-row-pawn_isolated'),
      );
      fireEvent.click(
        screen.getByTestId('current-metrics-row-mobility_knight'),
      );
      expect(onHighlight).toHaveBeenLastCalledWith({
        id: 'mobility_knight',
        squares: { white: ['f3'], black: [] },
      });
      expect(
        screen.getByTestId('current-metrics-row-pawn_isolated'),
      ).toHaveAttribute('data-selected', 'false');
      expect(
        screen.getByTestId('current-metrics-row-mobility_knight'),
      ).toHaveAttribute('data-selected', 'true');
    });
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
