/**
 * KS-4033 / KS-4036 / KS-4038 / KS-4043. Тесты вкладки «Метрики»
 * (одна строка-блок на каждый из 7 семантических разделов Stockfish 18).
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

describe('<CurrentPositionMetricsPanel> KS-4043', () => {
  it('агрегирует подкомпоненты по 7 блокам и сортирует по убыванию |diff|', () => {
    const subterms: PositionalSubterm[] = [
      sub('mobility_knight', 'w', 50, 50), // блок mobility, diff=+50
      sub('threat_hanging', 'b', 10, 10), // блок threats, diff=−10
      sub('pawn_connected', 'w', 2, 2), // блок pawn-structure, diff=+2
    ];
    render(
      <CurrentPositionMetricsPanel
        fen={STARTING_FEN}
        metricsOverride={readyOverride(subterms)}
      />,
    );
    const rows = screen.getAllByTestId(
      /^current-metrics-row-(?!value|white|black|label-wrap|popover)[a-z-]+$/,
    );
    // Сначала непустые по убыванию |diff|, потом пустые блоки в
    // исходном Gherkin-порядке (материал → … → проходные).
    expect(rows[0]).toHaveAttribute(
      'data-testid',
      'current-metrics-row-mobility',
    );
    expect(rows[1]).toHaveAttribute(
      'data-testid',
      'current-metrics-row-threats',
    );
    expect(rows[2]).toHaveAttribute(
      'data-testid',
      'current-metrics-row-pawn-structure',
    );
  });

  it('подкомпоненты вне блоков (space, king_safe_check_*, king_attackers_*, psqt_*) НЕ показаны', () => {
    const subterms: PositionalSubterm[] = [
      sub('space', 'w', 5, 5),
      sub('king_safe_check_rook', 'b', -5.8, -5.8),
      sub('king_attackers_count', 'w', 3, 3),
      sub('psqt_pawn', 'w', 30, 30),
      // Только этот попадает на UI.
      sub('mobility_knight', 'w', 4, 4),
    ];
    render(
      <CurrentPositionMetricsPanel
        fen={STARTING_FEN}
        metricsOverride={readyOverride(subterms)}
      />,
    );
    const valueRows = screen.getAllByTestId(
      /^current-metrics-row-(?!value|white|black|label-wrap|popover)[a-z-]+$/,
    );
    // 7 строк-блоков всегда рендерятся (пустые блоки тоже видны для
    // консистентности — Gherkin-порядок). Главное — нет отдельных
    // строк для исключённых id.
    expect(valueRows).toHaveLength(7);
    expect(
      screen.queryByTestId('current-metrics-row-king_safe_check_rook'),
    ).toBeNull();
    expect(
      screen.queryByTestId('current-metrics-row-king_attackers_count'),
    ).toBeNull();
    expect(
      screen.queryByTestId('current-metrics-row-psqt_pawn'),
    ).toBeNull();
    // А «Подвижность» с +4 — рендерится.
    expect(
      screen.getByTestId('current-metrics-row-value-mobility'),
    ).toHaveTextContent('+4.0');
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
    expect(
      screen.queryByTestId('current-metrics-row-white-mobility'),
    ).toBeNull();
    fireEvent.click(screen.getByTestId('current-metrics-mode-parallel'));
    expect(
      screen.getByTestId('current-metrics-row-white-mobility'),
    ).toHaveTextContent('50.0');
    expect(
      screen.getByTestId('current-metrics-row-black-mobility'),
    ).toHaveTextContent('20.0');
  });

  describe('подсветка клеток при клике (KS-4033 / KS-4043)', () => {
    it('клик по строке-блоку передаёт объединённые клетки всех подкомпонент', () => {
      const subterms: PositionalSubterm[] = [
        sub('pawn_isolated', 'w', 5, 5, 'd4'),
        sub('pawn_doubled', 'w', 3, 3, 'd5'),
        sub('pawn_backward', 'b', 4, 4, 'h7'),
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
        screen.getByTestId('current-metrics-row-pawn-structure'),
      );
      expect(onHighlight).toHaveBeenLastCalledWith({
        id: 'pawn-structure',
        squares: { white: ['d4', 'd5'], black: ['h7'] },
      });
    });

    it('повторный клик по той же строке снимает подсветку', () => {
      const subterms: PositionalSubterm[] = [
        sub('pawn_isolated', 'w', 5, 5, 'd4'),
      ];
      const onHighlight = vi.fn();
      render(
        <CurrentPositionMetricsPanel
          fen={STARTING_FEN}
          metricsOverride={readyOverride(subterms)}
          onHighlightSquares={onHighlight}
        />,
      );
      const row = screen.getByTestId('current-metrics-row-pawn-structure');
      fireEvent.click(row);
      fireEvent.click(row);
      expect(onHighlight).toHaveBeenLastCalledWith(null);
    });
  });

  it('поповер показывает локализованное имя блока и подкомпоненты вклада', () => {
    const subterms: PositionalSubterm[] = [
      sub('mobility_knight', 'w', 5, 5),
      sub('mobility_bishop', 'w', 3, 3),
    ];
    render(
      <CurrentPositionMetricsPanel
        fen={STARTING_FEN}
        metricsOverride={readyOverride(subterms)}
      />,
    );
    const popover = screen.getByTestId('current-metrics-row-popover-mobility');
    expect(popover).toHaveAttribute('role', 'tooltip');
    expect(popover).toHaveTextContent('mobility_knight');
    expect(popover).toHaveTextContent('mobility_bishop');
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
});
