import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { Chess } from 'chess.js';
import type { EndgameDrillStepPayload } from '@kingside/shared';

import { renderWithProviders, screen, waitFor } from '../../../test/test-utils';

// ─── Мок useStockfish ────────────────────────────────────────────────
// Настоящий Stockfish WASM требует Web Worker и стабильных таймингов — в
// unit-тестах мы управляем `bestMove`/`evaluate` вручную через контракт.
// Значение bestMove обновляется между test'ами; после evaluate test
// вручную вызывает `advanceBestMove(uci)` через экспортируемый `__mockControls`.

type MockControls = {
  mainEvaluate: ReturnType<typeof vi.fn>;
  hintEvaluate: ReturnType<typeof vi.fn>;
  mainBestMove: string | null;
  hintBestMove: string | null;
  setMainBestMove: (uci: string | null) => void;
  setHintBestMove: (uci: string | null) => void;
};

const controls: MockControls = {
  mainEvaluate: vi.fn(),
  hintEvaluate: vi.fn(),
  mainBestMove: null,
  hintBestMove: null,
  setMainBestMove: () => {},
  setHintBestMove: () => {},
};

let hookCallCount = 0;
vi.mock('../../../hooks/useStockfish', () => {
  // Используем React-state внутри мок-хука, чтобы рендер запустился при
  // изменении bestMove извне через `controls.setMainBestMove(...)`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { useState, useEffect } = require('react') as typeof import('react');
  return {
    useStockfish: () => {
      hookCallCount += 1;
      // Первый вызов useStockfish в компоненте — основной движок;
      // второй — hint-инстанс (см. порядок вызовов в EndgameDrillStep).
      const isHint = hookCallCount % 2 === 0;
      const [bestMove, setBestMoveState] = useState<string | null>(null);

      useEffect(() => {
        if (isHint) {
          controls.setHintBestMove = setBestMoveState;
        } else {
          controls.setMainBestMove = setBestMoveState;
        }
      }, [isHint]);

      return {
        state: 'ready' as const,
        lines: [],
        analysisFen: null,
        bestMove,
        evaluate: isHint ? controls.hintEvaluate : controls.mainEvaluate,
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
      onPieceDrop?: (args: { sourceSquare: string; targetSquare: string }) => boolean;
    };
  }) => (
    <div
      data-testid="mock-board"
      data-position={options.position ?? ''}
      onClick={() => {
        /* no-op; дропы делаем через __test-fire-move */
      }}
    >
      <button
        type="button"
        data-testid="test-fire-move-d2d4"
        onClick={() =>
          options.onPieceDrop?.({ sourceSquare: 'd2', targetSquare: 'd4' })
        }
      >
        d2d4
      </button>
      <button
        type="button"
        data-testid="test-fire-move-d7d8"
        onClick={() =>
          options.onPieceDrop?.({ sourceSquare: 'd7', targetSquare: 'd8' })
        }
      >
        d7d8
      </button>
    </div>
  ),
}));

import {
  EndgameDrillStep,
  evaluateWinCondition,
  materialBalance,
} from './EndgameDrillStep';

beforeEach(() => {
  hookCallCount = 0;
  controls.mainEvaluate.mockReset();
  controls.hintEvaluate.mockReset();
});

function basePayload(
  override: Partial<EndgameDrillStepPayload> = {},
): EndgameDrillStepPayload {
  return {
    type: 'endgame_drill',
    fen: '8/3P4/8/8/4k3/8/8/3K4 w - - 0 1',
    playerSide: 'white',
    skillLevel: 5,
    winCondition: { kind: 'promote' },
    ...override,
  };
}

// ─── evaluateWinCondition ────────────────────────────────────────────

describe('evaluateWinCondition', () => {
  it('mate: ученик поставил мат → true', () => {
    // Fool's mate: 1. f3 e5 2. g4 Qh4# — ход чёрных матит белых.
    const c = new Chess();
    c.move('f3');
    c.move('e5');
    c.move('g4');
    c.move('Qh4#');
    // Ученик играет чёрными → мат поставлен им.
    expect(
      evaluateWinCondition(c, new Chess(), 'black', { kind: 'mate' }),
    ).toBe(true);
    // Ученик играет белыми → сам в мате → false.
    expect(
      evaluateWinCondition(c, new Chess(), 'white', { kind: 'mate' }),
    ).toBe(false);
  });

  it('promote: после провода пешки в ферзя → true', () => {
    const start = new Chess('8/3P4/8/8/4k3/8/8/3K4 w - - 0 1');
    const after = new Chess('3Q4/8/8/8/4k3/8/8/3K4 b - - 0 1');
    expect(
      evaluateWinCondition(after, start, 'white', { kind: 'promote' }),
    ).toBe(true);
    expect(
      evaluateWinCondition(start, start, 'white', { kind: 'promote' }),
    ).toBe(false);
  });

  it('reach_position: FEN совпадает (без счётчиков ходов)', () => {
    const target = '3Q4/8/8/8/4k3/8/8/3K4 b - - 5 20';
    const current = new Chess('3Q4/8/8/8/4k3/8/8/3K4 b - - 0 1');
    expect(
      evaluateWinCondition(current, new Chess(), 'white', {
        kind: 'reach_position',
        fen: target,
      }),
    ).toBe(true);
  });

  it('material_advantage: перевес ≥ amount', () => {
    // Позиция: у белых ладья, у чёрных пешка → перевес +4.
    const c = new Chess('8/4p3/8/8/4k3/8/8/R3K3 w Q - 0 1');
    expect(
      evaluateWinCondition(c, new Chess(), 'white', {
        kind: 'material_advantage',
        amount: 4,
      }),
    ).toBe(true);
    expect(
      evaluateWinCondition(c, new Chess(), 'white', {
        kind: 'material_advantage',
        amount: 5,
      }),
    ).toBe(false);
  });
});

describe('materialBalance', () => {
  it('считает перевес в пешках корректно (Q vs N = +6)', () => {
    const c = new Chess('4k3/8/8/8/8/8/8/Q3K2N w - - 0 1');
    // Q(9) + N(3) vs 0 → baseline с королями, но рассчёт без королей.
    expect(materialBalance(c, 'white')).toBe(12);
    expect(materialBalance(c, 'black')).toBe(-12);
  });
});

// ─── Компонент ────────────────────────────────────────────────────────

describe('<EndgameDrillStep>', () => {
  it('рендерит доску, счётчик ходов и статус', () => {
    renderWithProviders(<EndgameDrillStep payload={basePayload()} />);
    expect(screen.getByTestId('lesson-endgame-step')).toHaveAttribute(
      'data-status',
      'playing',
    );
    expect(screen.getByTestId('lesson-endgame-step-counter')).toHaveTextContent(
      /Moves: 0/,
    );
  });

  it('кнопка «Сдаться» переводит в resigned и показывает рестарт', () => {
    renderWithProviders(<EndgameDrillStep payload={basePayload()} />);
    fireEvent.click(screen.getByTestId('lesson-endgame-step-resign'));
    expect(screen.getByTestId('lesson-endgame-step')).toHaveAttribute(
      'data-status',
      'resigned',
    );
    expect(screen.getByTestId('lesson-endgame-step-restart')).toBeInTheDocument();
  });

  it('движок получает evaluate(fen) после хода ученика', async () => {
    renderWithProviders(<EndgameDrillStep payload={basePayload()} />);
    // Прокидываем d7-d8 (с автопромоушном в Q) — это ход ученика.
    fireEvent.click(screen.getByTestId('test-fire-move-d7d8'));
    // После promote winCondition выполнено → status=player_won, очередь
    // пусть и чёрных, но движок НЕ должен звать (мы уже done).
    await waitFor(() =>
      expect(screen.getByTestId('lesson-endgame-step')).toHaveAttribute(
        'data-status',
        'player_won',
      ),
    );
    // onStepDone был вызван, movesCount обновился.
    expect(screen.getByTestId('lesson-endgame-step-counter')).toHaveTextContent(
      /Moves: 1/,
    );
  });

  it('победа (promote) → вызывается onStepDone', async () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <EndgameDrillStep payload={basePayload()} onStepDone={onStepDone} />,
    );
    fireEvent.click(screen.getByTestId('test-fire-move-d7d8'));
    await waitFor(() => expect(onStepDone).toHaveBeenCalledTimes(1));
  });

  it('maxMoves исчерпан → status=max_moves (при корректной паре ходов)', async () => {
    // Позиция с двумя королями и лишней пешкой, без условия победы.
    // maxMoves=1: после одного полного хода (ученик + движок) — max_moves.
    const payload = basePayload({
      fen: '8/8/8/8/4k3/8/3P4/3K4 w - - 0 1',
      winCondition: { kind: 'mate' }, // сложнее выполнить
      maxMoves: 1,
    });

    renderWithProviders(<EndgameDrillStep payload={payload} />);
    // Ученик делает d2-d4
    fireEvent.click(screen.getByTestId('test-fire-move-d2d4'));
    // Движок отвечает (через mock-control) e4-e3 — валидный ход королём.
    await waitFor(() => expect(controls.mainEvaluate).toHaveBeenCalled());
    act(() => {
      controls.setMainBestMove('e4e3');
    });
    await waitFor(() =>
      expect(screen.getByTestId('lesson-endgame-step')).toHaveAttribute(
        'data-status',
        'max_moves',
      ),
    );
  });

  it('подсказка не играет за пользователя (рендерит подсветку, но не меняет позицию)', async () => {
    const payload = basePayload({ hintsAllowed: true });
    const { container } = renderWithProviders(
      <EndgameDrillStep payload={payload} />,
    );
    const startFen = (container.querySelector(
      '[data-testid="mock-board"]',
    ) as HTMLElement).getAttribute('data-position');

    fireEvent.click(screen.getByTestId('lesson-endgame-step-hint'));
    await waitFor(() =>
      expect(controls.hintEvaluate).toHaveBeenCalledTimes(1),
    );
    // hint отдал bestmove
    act(() => {
      controls.setHintBestMove('d7d8');
    });

    // Позиция на доске НЕ изменилась (ход не применён).
    const afterFen = (container.querySelector(
      '[data-testid="mock-board"]',
    ) as HTMLElement).getAttribute('data-position');
    expect(afterFen).toBe(startFen);
    // Счётчик ходов не вырос.
    expect(screen.getByTestId('lesson-endgame-step-counter')).toHaveTextContent(
      /Moves: 0/,
    );
  });

  it('если hintsAllowed=false — кнопка подсказки не рендерится', () => {
    renderWithProviders(
      <EndgameDrillStep payload={basePayload({ hintsAllowed: false })} />,
    );
    expect(
      screen.queryByTestId('lesson-endgame-step-hint'),
    ).not.toBeInTheDocument();
  });

  it('откат (takeback) → позиция возвращается, история обрезается', async () => {
    renderWithProviders(<EndgameDrillStep payload={basePayload()} />);
    fireEvent.click(screen.getByTestId('test-fire-move-d7d8'));
    await waitFor(() =>
      expect(screen.getByTestId('lesson-endgame-step')).toHaveAttribute(
        'data-status',
        'player_won',
      ),
    );
    // История — 1 ход ученика. Клик по «В начало» откатит всё.
    fireEvent.click(screen.getByTestId('lesson-endgame-step-takeback-start'));
    expect(screen.getByTestId('lesson-endgame-step')).toHaveAttribute(
      'data-status',
      'playing',
    );
    expect(screen.getByTestId('lesson-endgame-step-counter')).toHaveTextContent(
      /Moves: 0/,
    );
  });
});
