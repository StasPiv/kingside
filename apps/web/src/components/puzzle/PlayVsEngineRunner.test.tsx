import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { renderWithProviders, screen } from '../../test/test-utils';
import { PlayVsEngineRunner } from './PlayVsEngineRunner';
import type {
  EngineAdapter,
  AnalysisResult,
  InfoLine,
} from '../../utils/engineAdapter';
import type { PuzzleDto } from '@kingside/shared';

/**
 * KS-2466 — юнит-тесты state-machine play-vs-engine. Реальный
 * Stockfish заменён на ScriptedEngine, который выдаёт заранее
 * подготовленные ответы по очереди (см. ADR-044 §5.2).
 */

// Мок MemoChessboard — кнопки fire-square-<id> вместо drag-flow.
vi.mock('../MemoChessboard', () => ({
  MemoChessboard: ({
    options,
  }: {
    options: {
      position?: string;
      onSquareClick?: (a: { piece: unknown; square: string }) => void;
      squareStyles?: Record<string, CSSProperties>;
    };
  }) => {
    const SQUARES = [
      'a1', 'b1', 'c1', 'd1', 'e1', 'f1', 'g1', 'h1',
      'a2', 'b2', 'c2', 'd2', 'e2', 'f2', 'g2', 'h2',
      'a3', 'b3', 'c3', 'd3', 'e3', 'f3', 'g3', 'h3',
      'a4', 'b4', 'c4', 'd4', 'e4', 'f4', 'g4', 'h4',
      'a5', 'b5', 'c5', 'd5', 'e5', 'f5', 'g5', 'h5',
      'a6', 'b6', 'c6', 'd6', 'e6', 'f6', 'g6', 'h6',
      'a7', 'b7', 'c7', 'd7', 'e7', 'f7', 'g7', 'h7',
      'a8', 'b8', 'c8', 'd8', 'e8', 'f8', 'g8', 'h8',
    ];
    return (
      <div data-testid="mock-board" data-position={options.position}>
        {SQUARES.map((sq) => (
          <button
            key={sq}
            type="button"
            data-testid={`fire-square-${sq}`}
            onClick={() => options.onSquareClick?.({ piece: null, square: sq })}
          >
            {sq}
          </button>
        ))}
      </div>
    );
  },
}));

// Дублируем мок useFastDrag чтобы не дёргать pointer-flow.
vi.mock('../../hooks/useFastDrag', () => ({
  useFastDrag: () => ({ suppressAnimationRef: { current: false } }),
}));

// useSounds — без аудио в jsdom.
vi.mock('../../hooks/useSounds', () => ({
  useSounds: () => ({ playSound: vi.fn() }),
  soundEventFromSan: () => 'move',
}));

class ScriptedEngine implements EngineAdapter {
  private queue: AnalysisResult[];

  constructor(queue: AnalysisResult[]) {
    // Клонируем, чтобы каждый тест мог пушить mutate.
    this.queue = [...queue];
  }

  async init(): Promise<void> { /* no-op */ }
  setOption(): void { /* no-op */ }

  async analyze(): Promise<AnalysisResult> {
    const next = this.queue.shift();
    if (!next) {
      // Пустой ответ — runner сам уйдёт в error, тест на это не рассчитан.
      return {
        lines: [],
        bestByDepth: new Map(),
        evalByDepth: new Map(),
        firstAppearance: 0,
      };
    }
    return next;
  }

  destroy(): void { /* no-op */ }
}

function line(score: InfoLine['score'], pv: string[], depth = 12, multipv = 1): InfoLine {
  return { depth, multipv, score, pv };
}

function result(infoLine: InfoLine): AnalysisResult {
  return {
    lines: [infoLine],
    bestByDepth: new Map([[infoLine.depth, infoLine.pv[0]]]),
    evalByDepth: new Map([[infoLine.depth, infoLine.score.value]]),
    firstAppearance: 1,
  };
}

function makePuzzle(over: Partial<PuzzleDto> = {}): PuzzleDto {
  return {
    id: 'p-test',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moves: '',
    rating: 1500,
    ratingDeviation: 75,
    popularity: 0,
    nbPlays: 0,
    themes: [],
    gameUrl: '',
    openingTags: '',
    solutionMode: 'play-vs-engine',
    playVsEngine: {
      blunderMove: 'd2d4',
      wdlAfterBlunder: 0.6,
      winThreshold: 0.5,
      failThreshold: 0.0,
      halfMovesN: 4,
    },
    ...over,
  };
}

beforeEach(() => {
  // Нет глобальной подготовки.
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlayVsEngineRunner KS-2466 state-machine', () => {
  it('win-engine-resign: после хода игрока движок видит mate против себя → win', async () => {
    // FEN: ход белых, ход e2e4 → после хода чёрные ходят и видят M-2 против себя.
    const puzzle = makePuzzle({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.9,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
      },
    });
    // Engine видит mate: score.type='mate', value=-2 → wdl_user = +1, resign.
    const engine = new ScriptedEngine([
      result(line({ type: 'mate', value: -2 }, ['e7e5'])),
    ]);
    const onSubmit = vi.fn();
    const { container } = renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} onSubmit={onSubmit} engineFactory={() => engine} />,
    );
    // user ход e2e4 (через mock-board: click e2 → click e4).
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="puzzle-engine-runner"]')?.getAttribute('data-state')).toBe('win');
    });
    expect(container.querySelector('[data-testid="puzzle-engine-runner"]')?.getAttribute('data-reason')).toBe('win-engine-resign');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.solved).toBe(true);
    expect(arg.reason).toBe('win-engine-resign');
    expect(arg.halfMovesPlayed).toBe(1);
  });

  it('lose-wdl: после первого хода wdl_user падает ниже failThreshold → lose', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.1,
        halfMovesN: 6,
      },
    });
    // Engine score POV chern (после хода белых) = +800 cp → wdl_engine ~= +0.88,
    // wdl_user = -0.88 < 0.1 → lose-wdl.
    const engine = new ScriptedEngine([
      result(line({ type: 'cp', value: 800 }, ['d7d5'])),
    ]);
    const onSubmit = vi.fn();
    const { container } = renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} onSubmit={onSubmit} engineFactory={() => engine} />,
    );
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="puzzle-engine-runner"]')?.getAttribute('data-state')).toBe('lose');
    });
    expect(container.querySelector('[data-testid="puzzle-engine-runner"]')?.getAttribute('data-reason')).toBe('lose-wdl');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.solved).toBe(false);
    expect(arg.reason).toBe('lose-wdl');
    expect(arg.finalWdl).toBeLessThan(0.1);
  });

  it('win по итогу N полуходов: финальный wdl_user >= winThreshold → win', async () => {
    // halfMovesN=2: user ход → engine ход → break → final analyze.
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 2,
      },
    });
    // 1) После user move: POV engine cp=-300 → wdl_engine≈-0.37, wdl_user≈+0.37 (≥0.0=failThreshold)
    //    → state=engine, apply bestmove e7e5.
    // 2) Final analyze (halfMovesPlayed=2 == N): POV user (white) cp=+600 → wdl_user≈+0.64
    //    → win.
    const engine = new ScriptedEngine([
      result(line({ type: 'cp', value: -300 }, ['e7e5'])),
      result(line({ type: 'cp', value: 600 }, ['d2d4'])),
    ]);
    const onSubmit = vi.fn();
    const { container } = renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} onSubmit={onSubmit} engineFactory={() => engine} />,
    );
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="puzzle-engine-runner"]')?.getAttribute('data-state')).toBe('win');
    });
    expect(container.querySelector('[data-testid="puzzle-engine-runner"]')?.getAttribute('data-reason')).toBe('win');
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.solved).toBe(true);
    expect(arg.halfMovesPlayed).toBe(2);
    expect(arg.finalWdl).toBeGreaterThanOrEqual(0.5);
  });

  it('win-mate: ход игрока ставит мат соперника', async () => {
    // Backrank: 6k1/5ppp/8/8/8/8/8/R6K w - - 0 1.
    // Ход a1a8 = мат. После него next.isCheckmate() → win-mate, движок не нужен,
    // но мы должны отдать что-то для analyze (выполняется до checkmate-проверки).
    const puzzle = makePuzzle({
      fen: '6k1/5ppp/8/8/8/8/8/R6K w - - 0 1',
      playVsEngine: {
        blunderMove: 'g7g6',
        wdlAfterBlunder: 0.95,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
      },
    });
    const engine = new ScriptedEngine([
      // analyze после мата: даём score mate -1 (любой мат против side-to-move).
      result(line({ type: 'mate', value: -1 }, ['g8h8'])),
    ]);
    const onSubmit = vi.fn();
    const { container } = renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} onSubmit={onSubmit} engineFactory={() => engine} />,
    );
    (screen.getByTestId('fire-square-a1') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-a8') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="puzzle-engine-runner"]')?.getAttribute('data-state')).toBe('win');
    });
    expect(container.querySelector('[data-testid="puzzle-engine-runner"]')?.getAttribute('data-reason')).toBe('win-mate');
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.solved).toBe(true);
    expect(arg.reason).toBe('win-mate');
    expect(arg.finalWdl).toBe(1);
  });

  it('initial: показывает blunder-hint и halfMovesLeft = N до первого хода', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
      },
    });
    const engine = new ScriptedEngine([]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    expect(screen.getByTestId('puzzle-engine-blunder-hint')).toBeInTheDocument();
    expect(screen.getByTestId('puzzle-engine-progress').textContent).toMatch(/6/);
  });
});
