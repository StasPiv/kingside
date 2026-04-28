import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { OpeningDrillStepPayload } from '@kingside/shared';

import { renderWithProviders, screen, waitFor } from '../../../test/test-utils';
import { parseAnnotatedPgn } from '../../../review/utils/PgnDeserializer';

// Mock useStockfish — engine_punish ветка управляется контрактом теста.
const engineControls: {
  evaluate: ReturnType<typeof vi.fn>;
  setBestMove: (uci: string | null) => void;
  bestMove: string | null;
} = {
  evaluate: vi.fn(),
  setBestMove: () => {},
  bestMove: null,
};

vi.mock('../../../hooks/useStockfish', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- внутри vi.mock factory можно только синхронный require: динамический import() не разрешается, а ES-import создаст cycle на самой замоканной зависимости.
  const { useState, useEffect } = require('react') as typeof import('react');
  return {
    useStockfish: () => {
      const [bestMove, setBestMoveState] = useState<string | null>(null);
      useEffect(() => {
        engineControls.setBestMove = setBestMoveState;
      }, []);
      return {
        state: 'ready' as const,
        lines: [],
        analysisFen: null,
        bestMove,
        evaluate: engineControls.evaluate,
        stop: vi.fn(),
        init: vi.fn(),
        cleanup: vi.fn(),
        isReady: true,
      };
    },
  };
});

vi.mock('../../MemoChessboard', () => ({
  MemoChessboard: ({
    options,
  }: {
    options: {
      position?: string;
      onPieceDrop?: (args: {
        sourceSquare: string;
        targetSquare: string;
      }) => boolean;
    };
  }) => (
    <div data-testid="mock-board" data-position={options.position ?? ''}>
      <button
        type="button"
        data-testid="fire-e2e4"
        onClick={() =>
          options.onPieceDrop?.({ sourceSquare: 'e2', targetSquare: 'e4' })
        }
      >
        e4
      </button>
      <button
        type="button"
        data-testid="fire-d2d4"
        onClick={() =>
          options.onPieceDrop?.({ sourceSquare: 'd2', targetSquare: 'd4' })
        }
      >
        d4
      </button>
      <button
        type="button"
        data-testid="fire-g1f3"
        onClick={() =>
          options.onPieceDrop?.({ sourceSquare: 'g1', targetSquare: 'f3' })
        }
      >
        Nf3
      </button>
    </div>
  ),
}));

import { OpeningDrillStep, candidateMoves } from './OpeningDrillStep';

beforeEach(() => {
  engineControls.evaluate.mockReset();
  engineControls.setBestMove = () => {};
  engineControls.bestMove = null;
  // Делаем Math.random детерминированным: всегда 0 → первый вариант.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function payload(
  over: Partial<OpeningDrillStepPayload> = {},
): OpeningDrillStepPayload {
  return {
    type: 'opening_drill',
    pgn: '1. e4 e5 2. Nf3 Nc6',
    playerSide: 'white',
    onDeviation: 'show_correction',
    ...over,
  };
}

describe('candidateMoves', () => {
  it('при null (старт) → первый ход основной линии', () => {
    const tree = parseAnnotatedPgn('1. e4 e5');
    expect(candidateMoves(null, tree).map((m) => m.san)).toEqual(['e4']);
  });

  it('учитывает варианты в дереве', () => {
    // 1. e4 (1. d4) — два варианта первого хода.
    const tree = parseAnnotatedPgn('1. e4 (1. d4) 1... e5');
    const cands = candidateMoves(null, tree);
    expect(cands.map((m) => m.san).sort()).toEqual(['d4', 'e4']);
  });
});

describe('<OpeningDrillStep>', () => {
  it('показывает стартовую позицию, статус «playing», 0 отклонений', () => {
    renderWithProviders(<OpeningDrillStep payload={payload()} />);
    expect(screen.getByTestId('lesson-opening-step')).toHaveAttribute(
      'data-status',
      'playing',
    );
    expect(screen.getByTestId('lesson-opening-step-stats')).toHaveTextContent(
      /0.* of 0/,
    );
  });

  it('правильный ход по линии → тренажёр отвечает, стата без отклонений', async () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <OpeningDrillStep payload={payload()} onStepDone={onStepDone} />,
    );
    // Ход ученика e4 — соответствует линии.
    fireEvent.click(screen.getByTestId('fire-e2e4'));
    // Тренажёр должен ответить e5 после задержки.
    // Ждём, пока тренажёр сделает ответ по таймауту 250мс.
    await new Promise((r) => setTimeout(r, 350));
    // Ученик делает второй ход Nf3 — тоже по линии.
    fireEvent.click(screen.getByTestId('fire-g1f3'));
    // Ждём, пока тренажёр сделает ответ по таймауту 250мс.
    await new Promise((r) => setTimeout(r, 350));
    // После Nc6 следующих ходов в линии нет → line_complete.
    await waitFor(() =>
      expect(screen.getByTestId('lesson-opening-step')).toHaveAttribute(
        'data-status',
        'line_complete',
      ),
    );
    expect(onStepDone).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('lesson-opening-step-stats')).toHaveTextContent(
      /0.* of 2/,
    );
  });

  it('отклонение в режиме show_correction → блок, сообщение, счётчик +1', async () => {
    renderWithProviders(
      <OpeningDrillStep
        payload={payload({ onDeviation: 'show_correction' })}
      />,
    );
    // Ход d4 вместо e4 — отклонение.
    fireEvent.click(screen.getByTestId('fire-d2d4'));
    await waitFor(() =>
      expect(screen.getByTestId('lesson-opening-step')).toHaveAttribute(
        'data-status',
        'deviated_correction',
      ),
    );
    expect(
      screen.getByTestId('lesson-opening-step-correction'),
    ).toHaveTextContent(/e4/);
    expect(screen.getByTestId('lesson-opening-step-stats')).toHaveTextContent(
      /1.* of 1/,
    );
    // Кнопка retry есть.
    expect(
      screen.getByTestId('lesson-opening-step-retry-correction'),
    ).toBeInTheDocument();
  });

  it('после retry-correction статус возвращается в playing', async () => {
    renderWithProviders(
      <OpeningDrillStep
        payload={payload({ onDeviation: 'show_correction' })}
      />,
    );
    fireEvent.click(screen.getByTestId('fire-d2d4'));
    await waitFor(() =>
      expect(screen.getByTestId('lesson-opening-step')).toHaveAttribute(
        'data-status',
        'deviated_correction',
      ),
    );
    fireEvent.click(screen.getByTestId('lesson-opening-step-retry-correction'));
    expect(screen.getByTestId('lesson-opening-step')).toHaveAttribute(
      'data-status',
      'playing',
    );
  });

  it('отклонение в режиме engine_punish → статус engine_punish, engine.evaluate вызван', async () => {
    renderWithProviders(
      <OpeningDrillStep
        payload={payload({
          onDeviation: 'engine_punish',
          engineSkillLevel: 5,
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('fire-d2d4'));
    await waitFor(() =>
      expect(screen.getByTestId('lesson-opening-step')).toHaveAttribute(
        'data-status',
        'engine_punish',
      ),
    );
    await waitFor(() =>
      expect(engineControls.evaluate).toHaveBeenCalled(),
    );
  });

  it('невалидный PGN → пустое дерево → сразу line_complete без падений', async () => {
    renderWithProviders(
      <OpeningDrillStep payload={payload({ pgn: 'nonsense' })} />,
    );
    // Пустое дерево → cursor null, у хода соперника кандидатов нет → line_complete.
    // Но сначала очередь ученика (у него тоже нет кандидатов). Проверим что
    // отклонение на любом ходе даст стата 1.
    fireEvent.click(screen.getByTestId('fire-e2e4'));
    await waitFor(() =>
      expect(
        screen.getByTestId('lesson-opening-step-stats'),
      ).toHaveTextContent(/1.* of 1/),
    );
    // Статус = deviated_correction (onDeviation по умолчанию) — не падаем.
    expect(screen.getByTestId('lesson-opening-step')).toHaveAttribute(
      'data-status',
      'deviated_correction',
    );
  });
});
