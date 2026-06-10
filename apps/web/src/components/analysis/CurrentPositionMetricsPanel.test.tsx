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

  it('подкомпоненты вне блоков (king_safe_check_*, king_attackers_*, psqt_*) НЕ показаны; space идёт в блок «Пространство»', () => {
    const subterms: PositionalSubterm[] = [
      sub('space', 'w', 5, 5),
      sub('king_safe_check_rook', 'b', -5.8, -5.8),
      sub('king_attackers_count', 'w', 3, 3),
      sub('psqt_pawn', 'w', 30, 30),
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
    // 8 строк-блоков всегда рендерятся (KS-4043 follow-up: добавлен space).
    expect(valueRows).toHaveLength(8);
    expect(
      screen.queryByTestId('current-metrics-row-king_safe_check_rook'),
    ).toBeNull();
    expect(
      screen.queryByTestId('current-metrics-row-king_attackers_count'),
    ).toBeNull();
    expect(
      screen.queryByTestId('current-metrics-row-psqt_pawn'),
    ).toBeNull();
    // А блок «Пространство» с diff=+5 — рендерится.
    expect(
      screen.getByTestId('current-metrics-row-value-space'),
    ).toHaveTextContent('+5.00');
    // А «Подвижность» с diff=+4 — рендерится в формате пешек до сотых.
    expect(
      screen.getByTestId('current-metrics-row-value-mobility'),
    ).toHaveTextContent('+4.00');
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
    // KS-4043 follow-up: вывод в пешках с точностью до сотых
    // (значения trace уже в пешках, не делим на 100).
    expect(
      screen.getByTestId('current-metrics-row-white-mobility'),
    ).toHaveTextContent('50.00');
    expect(
      screen.getByTestId('current-metrics-row-black-mobility'),
    ).toHaveTextContent('20.00');
  });

  describe('двойная вложенность блок ↔ подкомпонента (KS-4043 follow-up)', () => {
    it('клик по строке-блоку только раскрывает блок, подсветку клеток НЕ включает', () => {
      const subterms: PositionalSubterm[] = [
        sub('pawn_isolated', 'w', 5, 5, 'd4'),
        sub('pawn_doubled', 'w', 3, 3, 'd5'),
      ];
      const onHighlight = vi.fn();
      render(
        <CurrentPositionMetricsPanel
          fen={STARTING_FEN}
          metricsOverride={readyOverride(subterms)}
          onHighlightSquares={onHighlight}
        />,
      );
      const blockRow = screen.getByTestId('current-metrics-row-pawn-structure');
      fireEvent.click(blockRow);
      // Подкомпоненты появились.
      expect(
        screen.getByTestId('current-metrics-block-contributions-pawn-structure'),
      ).toBeInTheDocument();
      // Колбэк подсветки не вызывался.
      expect(onHighlight).not.toHaveBeenCalled();
    });

    it('клик по подкомпоненте внутри раскрытого блока подсвечивает её клетки', () => {
      const subterms: PositionalSubterm[] = [
        sub('pawn_isolated', 'w', 5, 5, 'd4'),
        sub('pawn_doubled', 'w', 3, 3, 'd5'),
      ];
      const onHighlight = vi.fn();
      render(
        <CurrentPositionMetricsPanel
          fen={STARTING_FEN}
          metricsOverride={readyOverride(subterms)}
          onHighlightSquares={onHighlight}
        />,
      );
      // Раскрываем блок.
      fireEvent.click(
        screen.getByTestId('current-metrics-row-pawn-structure'),
      );
      // Клик по конкретной подкомпоненте.
      fireEvent.click(
        screen.getByTestId('current-metrics-contribution-pawn_isolated'),
      );
      expect(onHighlight).toHaveBeenLastCalledWith({
        id: 'pawn_isolated',
        squares: { white: ['d4'], black: [] },
      });
    });

    it('повторный клик по той же подкомпоненте снимает подсветку', () => {
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
      fireEvent.click(
        screen.getByTestId('current-metrics-row-pawn-structure'),
      );
      const contrib = screen.getByTestId(
        'current-metrics-contribution-pawn_isolated',
      );
      fireEvent.click(contrib);
      fireEvent.click(contrib);
      expect(onHighlight).toHaveBeenLastCalledWith(null);
    });

    it('повторный клик по блоку сворачивает его', () => {
      const subterms: PositionalSubterm[] = [
        sub('pawn_isolated', 'w', 5, 5, 'd4'),
      ];
      render(
        <CurrentPositionMetricsPanel
          fen={STARTING_FEN}
          metricsOverride={readyOverride(subterms)}
        />,
      );
      const blockRow = screen.getByTestId('current-metrics-row-pawn-structure');
      fireEvent.click(blockRow);
      expect(
        screen.getByTestId('current-metrics-block-contributions-pawn-structure'),
      ).toBeInTheDocument();
      fireEvent.click(blockRow);
      expect(
        screen.queryByTestId('current-metrics-block-contributions-pawn-structure'),
      ).toBeNull();
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

  describe('LLM-трактовка метрик (KS-4044)', () => {
    it('кнопка «Объяснить позицию» скрыта без analysisId', () => {
      const subterms: PositionalSubterm[] = [
        sub('mobility_knight', 'w', 5, 5),
      ];
      render(
        <CurrentPositionMetricsPanel
          fen={STARTING_FEN}
          metricsOverride={readyOverride(subterms)}
        />,
      );
      expect(
        screen.queryByTestId('current-metrics-explain-btn'),
      ).toBeNull();
    });

    it('клик по кнопке шлёт корректный payload и рендерит summary + комментарии блоков', async () => {
      const subterms: PositionalSubterm[] = [
        sub('mobility_knight', 'w', 60, 60),
        sub('mobility_knight', 'b', 20, 20),
      ];
      const requestOverride = vi.fn().mockResolvedValue({
        summary: 'У белых небольшой перевес в подвижности.',
        blocks: [
          {
            id: 'mobility' as const,
            verdict: 'перевес белых',
            comment: 'Кони активнее, чёрные стеснены.',
          },
        ],
      });
      render(
        <CurrentPositionMetricsPanel
          fen={STARTING_FEN}
          metricsOverride={readyOverride(subterms)}
          analysisId="an-1"
          requestMetricsCommentOverride={requestOverride}
        />,
      );
      const btn = screen.getByTestId('current-metrics-explain-btn');
      fireEvent.click(btn);
      // Дождёмся ответа.
      await screen.findByTestId('current-metrics-llm-summary');
      // Payload — корректная структура.
      expect(requestOverride).toHaveBeenCalledTimes(1);
      const [analysisIdArg, payload] = requestOverride.mock.calls[0];
      expect(analysisIdArg).toBe('an-1');
      expect(payload).toMatchObject({
        fen: STARTING_FEN,
        metrics: expect.objectContaining({
          mobility: { value_cp: 40 },
          material: { value_cp: 0 },
        }),
      });
      // Summary рендерится сверху.
      expect(
        screen.getByTestId('current-metrics-llm-summary'),
      ).toHaveTextContent('У белых небольшой перевес в подвижности.');
      // Комментарий для блока mobility рендерится под строкой блока.
      expect(
        screen.getByTestId('current-metrics-block-llm-mobility'),
      ).toHaveTextContent('перевес белых');
    });

    it('блоки без записи в ответе LLM остаются без комментария', async () => {
      const subterms: PositionalSubterm[] = [
        sub('mobility_knight', 'w', 60, 60),
      ];
      const requestOverride = vi.fn().mockResolvedValue({
        summary: 'Только подвижность важна.',
        blocks: [
          {
            id: 'mobility' as const,
            verdict: 'перевес белых',
            comment: 'OK',
          },
        ],
      });
      render(
        <CurrentPositionMetricsPanel
          fen={STARTING_FEN}
          metricsOverride={readyOverride(subterms)}
          analysisId="an-1"
          requestMetricsCommentOverride={requestOverride}
        />,
      );
      fireEvent.click(screen.getByTestId('current-metrics-explain-btn'));
      await screen.findByTestId('current-metrics-block-llm-mobility');
      // material нет в ответе → не должно быть блока комментария.
      expect(
        screen.queryByTestId('current-metrics-block-llm-material'),
      ).toBeNull();
    });

    it('graceful: при ошибке сети рисуется только баннер ошибки, метрики живут', async () => {
      const subterms: PositionalSubterm[] = [
        sub('mobility_knight', 'w', 5, 5),
      ];
      const requestOverride = vi.fn().mockRejectedValue(new Error('429'));
      render(
        <CurrentPositionMetricsPanel
          fen={STARTING_FEN}
          metricsOverride={readyOverride(subterms)}
          analysisId="an-1"
          requestMetricsCommentOverride={requestOverride}
        />,
      );
      fireEvent.click(screen.getByTestId('current-metrics-explain-btn'));
      await screen.findByTestId('current-metrics-llm-error');
      // Само значение мобильности по-прежнему отображается.
      expect(
        screen.getByTestId('current-metrics-row-mobility'),
      ).toBeInTheDocument();
    });
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
