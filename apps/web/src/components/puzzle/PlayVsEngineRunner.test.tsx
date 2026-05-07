import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { renderWithProviders, screen } from '../../test/test-utils';
import {
  PlayVsEngineRunner,
  uciToSan,
  blunderUciToSan,
  cpFromScore,
} from './PlayVsEngineRunner';
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

/**
 * KS-2507: первый запрос к движку — initial analyze стартовой позиции
 * (для EvalBar). ScriptedEngine выдаёт ответы FIFO, поэтому каждому
 * тесту прикрепляем «фиктивный» нулевой ответ в начало очереди.
 */
const INITIAL_ANALYZE = (): AnalysisResult =>
  result(line({ type: 'cp', value: 0 }, ['e2e4']));

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
    // KS-2473: + pre-analyze, поэтому отдаём 2 ответа.
    // KS-2507: + initial analyze стартовой позиции при mount.
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 50 }, ['e2e4'])), // pre-analyze
      result(line({ type: 'mate', value: -2 }, ['e7e5'])), // post-analyze
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
    // KS-2473: pre-analyze (PV1 до user-хода) запускается параллельно
    // с post-analyze. ScriptedEngine выдаёт ответы FIFO; для теста на
    // lose-сценарий важно, чтобы post-analyze обоих был отрицательным
    // wdl_user. Подаём 2 фиктивных результата (pre + post). Какой
    // первым — зависит от порядка вызовов; cp=+800 берёт оба.
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 800 }, ['d7d5'])),
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
    // KS-2473: pre-analyze запускается параллельно с post-analyze, FIFO.
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 100 }, ['e2e4'])), // pre-analyze user move 1
      result(line({ type: 'cp', value: -300 }, ['e7e5'])), // post-analyze 1
      result(line({ type: 'cp', value: 600 }, ['d2d4'])), // final analyze
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
    // KS-2473: pre + post analyze.
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 1500 }, ['a1a8'])), // pre-analyze
      result(line({ type: 'mate', value: -1 }, ['g8h8'])), // post-analyze (после мата)
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

  // KS-2509: блок bestmoveHint удалён — вместо него PostGameReview.
  // Тесты ниже (бывшие KS-2473/KS-2505/KS-2506) переписаны на проверку
  // классификации в строках post-game-review.

  it('KS-2473/KS-2509: post-game review показывает PV1 как «Best was» в позиции ДО user-хода (lose)', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.1,
        halfMovesN: 6,
      },
    });
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 50 }, ['d2d4'])), // pre: best=d2d4
      result(line({ type: 'cp', value: 800 }, ['d7d5'])), // post → lose-wdl
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    // user сыграл e2-e4 (по pre-analyze лучший = d2d4).
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(
        screen.getByTestId('puzzle-engine-runner').getAttribute('data-state'),
      ).toBe('lose');
    });
    // PostGameReview ждёт, пока классификация уже не graceful good
    // (т.е. pre/post уже допущены/fallback отработал).
    await waitFor(() => {
      const row = screen.queryByTestId('post-game-review-row-1');
      if (!row) throw new Error('row not yet built');
      const cls = row.getAttribute('data-class');
      if (cls === 'good') throw new Error('still graceful good');
    });
    const row = screen.getByTestId('post-game-review-row-1');
    expect(row.textContent).toMatch(/e4/); // played
    const best = screen.getByTestId('post-game-review-best-1');
    expect(best.textContent).toMatch(/d4/); // best
    expect(best.textContent).toMatch(/best was|лучше было/i);
  });

  it('KS-2505/2506/KS-2509: cp=+50 → cp=-800 даёт класс blunder (cp-loss=850)', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.1,
        halfMovesN: 6,
      },
    });
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 50 }, ['d2d4'])), // pre cpBefore=+50
      result(line({ type: 'cp', value: 800 }, ['d7d5'])), // post (POV opp) → cpAfter=-800
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(
        screen.getByTestId('puzzle-engine-runner').getAttribute('data-state'),
      ).toBe('lose');
    });
    await waitFor(() => {
      const row = screen.queryByTestId('post-game-review-row-1');
      if (!row || row.getAttribute('data-class') !== 'blunder') {
        throw new Error('not yet blunder');
      }
    });
    const row = screen.getByTestId('post-game-review-row-1');
    expect(row.getAttribute('data-class')).toBe('blunder');
  });

  it('KS-2506/KS-2509: post mate (engine матует) → cpAfter=−100000 → blunder', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.1,
        halfMovesN: 6,
      },
    });
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 50 }, ['d2d4'])),
      result(line({ type: 'mate', value: 2 }, ['d7d5'])),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(
        screen.getByTestId('puzzle-engine-runner').getAttribute('data-state'),
      ).toBe('lose');
    });
    await waitFor(() => {
      const row = screen.queryByTestId('post-game-review-row-1');
      if (!row || row.getAttribute('data-class') !== 'blunder') {
        throw new Error('not yet blunder');
      }
    });
  });

  it('KS-2505/KS-2509: mate в pre-analyze (cpBefore=+100000) и cp=-800 после → blunder', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.1,
        halfMovesN: 6,
      },
    });
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'mate', value: 3 }, ['d2d4'])),
      result(line({ type: 'cp', value: 800 }, ['d7d5'])),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(
        screen.getByTestId('puzzle-engine-runner').getAttribute('data-state'),
      ).toBe('lose');
    });
    await waitFor(() => {
      const row = screen.queryByTestId('post-game-review-row-1');
      if (!row || row.getAttribute('data-class') !== 'blunder') {
        throw new Error('not yet blunder');
      }
    });
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
    // KS-2507: initial pre-analyze стартовой позиции теперь идёт сразу
    // на mount, поэтому отдаём ScriptedEngine один ответ.
    const engine = new ScriptedEngine([
      result(line({ type: 'cp', value: 30 }, ['e2e4'])),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    expect(screen.getByTestId('puzzle-engine-blunder-hint')).toBeInTheDocument();
    expect(screen.getByTestId('puzzle-engine-progress').textContent).toMatch(/6/);
  });

  it('KS-2518: lose-wdl показывает summary с дельтой и заголовком «Advantage lost»', async () => {
    // wdlAfterBlunder=0.6 (старт), post-analyze cp=+800 POV opp →
    // wdlEngine ≈ +0.88, wdlUser ≈ -0.88, < failThreshold=0.1 → lose-wdl.
    // delta = 0.6 − (−0.88) = 1.48.
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.1,
        halfMovesN: 6,
      },
    });
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 50 }, ['d2d4'])),
      result(line({ type: 'cp', value: 800 }, ['d7d5'])),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(
        screen.getByTestId('puzzle-engine-runner').getAttribute('data-state'),
      ).toBe('lose');
    });
    const summary = screen.getByTestId('puzzle-engine-wdl-summary');
    expect(summary.getAttribute('data-preserved')).toBe('false');
    expect(summary.getAttribute('data-start-wdl')).toBe('0.60');
    // Дельта положительная (потеряно).
    const delta = Number(summary.getAttribute('data-delta-wdl'));
    expect(delta).toBeGreaterThan(0);
    expect(summary.textContent).toMatch(/Advantage lost|Преимущество потеряно/);
    const lineEl = screen.getByTestId('puzzle-engine-wdl-summary-line');
    expect(lineEl.textContent).toMatch(/Lost|Потеряно/);
    // Подстрока стартового значения формата +0.60.
    expect(lineEl.textContent).toMatch(/\+0\.60/);
  });

  it('KS-2518: win с финальным WDL ≥ старта → header «Advantage preserved», без «Lost»', async () => {
    // halfMovesN=2, после user-хода wdl остаётся ~+0.6, post-analyze
    // cp=-300 POV engine → wdl_engine≈-0.37, wdl_user≈+0.37 (≥0.0).
    // Final analyze cp=+600 → wdl_user≈+0.64 (≥winThreshold).
    // delta = 0.6 − 0.64 ≈ -0.04, preserved=true.
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 2,
      },
    });
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 100 }, ['e2e4'])),
      result(line({ type: 'cp', value: -300 }, ['e7e5'])),
      result(line({ type: 'cp', value: 600 }, ['d2d4'])),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(
        screen.getByTestId('puzzle-engine-runner').getAttribute('data-state'),
      ).toBe('win');
    });
    const summary = screen.getByTestId('puzzle-engine-wdl-summary');
    expect(summary.getAttribute('data-preserved')).toBe('true');
    expect(summary.textContent).toMatch(
      /Advantage preserved|Преимущество удержано/,
    );
    const lineEl = screen.getByTestId('puzzle-engine-wdl-summary-line');
    // На preserved «Lost: …» не выводится.
    expect(lineEl.textContent).not.toMatch(/Lost:|Потеряно:/);
  });

  it('KS-2510: клик по ходу в PostGameReview переключает доску на fenBefore', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.1,
        halfMovesN: 6,
      },
    });
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 50 }, ['d2d4'])),
      result(line({ type: 'cp', value: 800 }, ['d7d5'])),
    ]);
    const initialFen = puzzle.fen;
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(
        screen.getByTestId('puzzle-engine-runner').getAttribute('data-state'),
      ).toBe('lose');
    });
    // До клика по review reviewFen=null → атрибут пустой.
    const runner = screen.getByTestId('puzzle-engine-runner');
    expect(runner.getAttribute('data-review-fen')).toBe('');
    // Дожидаемся, пока review-кнопка появится (post-game-review зависит
    // от state win|lose).
    const btn = await waitFor(() => {
      const el = screen.queryByTestId('post-game-review-select-1');
      if (!el) throw new Error('select btn not yet rendered');
      return el as HTMLButtonElement;
    });
    btn.click();
    // После клика runner проставляет reviewFen = fenBefore первого
    // user-хода. На полуходе 1 fenBefore = initialFen пазла.
    await waitFor(() => {
      expect(
        screen.getByTestId('puzzle-engine-runner').getAttribute('data-review-fen'),
      ).toBe(initialFen);
    });
  });

  it('KS-2508: PostGameReview рендерится на win/lose с метками для каждого user-хода', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.1,
        halfMovesN: 6,
      },
    });
    // pre cp=+50 (POV user), post cp=+800 (POV opp) → cpAfter user=-800,
    //   cp-loss=850 → blunder. Также played(e2e4) != best(d2d4).
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 50 }, ['d2d4'])),
      result(line({ type: 'cp', value: 800 }, ['d7d5'])),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(
        screen.getByTestId('puzzle-engine-runner').getAttribute('data-state'),
      ).toBe('lose');
    });
    const review = await waitFor(() => {
      const el = screen.queryByTestId('post-game-review');
      if (!el) throw new Error('review not rendered yet');
      const row = el.querySelector('[data-testid="post-game-review-row-1"]');
      if (!row) throw new Error('row not yet built');
      const cls = row.getAttribute('data-class');
      // Дожидаемся, пока классификация уже опирается на cpAfter (а не
      // graceful good из-за null).
      if (cls === 'good') throw new Error('still graceful good');
      return el;
    });
    const row = review.querySelector(
      '[data-testid="post-game-review-row-1"]',
    ) as HTMLElement;
    expect(row.getAttribute('data-class')).toBe('blunder');
  });

  it('KS-2507: initial pre-analyze стартовой позиции — evalLines не пустой при mount', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
      },
    });
    // Один ответ — initial analyze. Без user-хода не должно быть других.
    const engine = new ScriptedEngine([
      result(line({ type: 'cp', value: 25 }, ['e2e4'])),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    // До initial analyze evalLines.length=0 (синхронный first-paint
    // через reset useEffect). После — 1 (отдали одну линию).
    await waitFor(() => {
      const root = screen.getByTestId('puzzle-engine-runner');
      const count = Number(root.getAttribute('data-eval-lines'));
      if (count <= 0) throw new Error('evalLines не дописались');
      expect(count).toBeGreaterThan(0);
    });
  });

  // KS-2486: ссылка «Open in Workshop» — всегда видна, href с FEN
  // пазла (initial). KS-2486 reopen: при наличии ходов href добавляет
  // `&pgn=...` чтобы Workshop открыл партию с начала.
  it('KS-2486: до первого хода href=/analysis?fen=<puzzle.fen> (без pgn)', async () => {
    const customFen = '1rb2rk1/3nq1bp/2n1p1p1/ppppPp2/5P2/P1PPBNP1/1P1N1QBP/R4RK1 w - - 2 15';
    const puzzle = makePuzzle({
      fen: customFen,
      playVsEngine: {
        blunderMove: 'a8b8',
        wdlAfterBlunder: 0.95,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
      },
    });
    // Engine не нужен для render-теста, но runner вызовет init/analyze в effect'е.
    const engine = new ScriptedEngine([
      result(line({ type: 'cp', value: 50 }, ['a1b1'])),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    const link = screen.getByTestId('puzzle-engine-workshop-link');
    expect(link).toBeInTheDocument();
    // history пустая → pgn-параметр не передаётся, только fen.
    expect(link.getAttribute('href')).toBe(
      `/analysis?fen=${encodeURIComponent(customFen)}`,
    );
    // target=_blank — мастерская в новой вкладке, не прерывает решение.
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
    // i18n текст — не fallback на ключ.
    const text = (link.textContent ?? '').trim();
    expect(text).toMatch(/Workshop|мастерской/i);
    expect(text).not.toContain('puzzle.engine.openInWorkshop');
  });

  // KS-2486 reopen: после ходов пользователя/движка href должен содержать
  // НАЧАЛЬНУЮ позицию пазла + PGN всех сделанных ходов, чтобы Workshop
  // открылся с начала партии и пользователь мог промотать каждый ход.
  it('KS-2486 reopen: после хода href содержит initialFen и pgn-параметр со всеми ходами', async () => {
    const puzzle = makePuzzle({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
      },
    });
    // 1) pre-analyze user-хода (e2e4): cp нейтральный.
    // 2) post-analyze: ход движка e7e5, wdl_user остаётся выше fail-threshold.
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 100 }, ['e2e4'])),
      result(line({ type: 'cp', value: -100 }, ['e7e5'])),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    // user ход e2e4 (mock-board: click e2 → click e4).
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    // Дожидаемся применения engine-ответа — после него в game.pgn()
    // должны быть оба полухода (e4 + e5).
    await waitFor(() => {
      const link = screen.getByTestId('puzzle-engine-workshop-link');
      const href = link.getAttribute('href') ?? '';
      // FEN — начальный пазла, не текущий.
      expect(href).toContain(
        `fen=${encodeURIComponent(puzzle.fen)}`,
      );
      // pgn-параметр присутствует и содержит SAN обоих ходов.
      expect(href).toMatch(/&pgn=/);
      const pgnEncoded = href.split('&pgn=')[1] ?? '';
      const pgnDecoded = decodeURIComponent(pgnEncoded);
      expect(pgnDecoded).toContain('e4');
      expect(pgnDecoded).toContain('e5');
    });
  });
});

/**
 * KS-2471: UCI→SAN конвертация. blunderUciToSan восстанавливает before-FEN
 * (фигура с `to` обратно на `from`, side-to-move инвертирован).
 */
describe('uciToSan / blunderUciToSan KS-2471', () => {
  it('uciToSan: легальный ход → SAN', () => {
    expect(
      uciToSan('e2e4', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
    ).toBe('e4');
  });

  it('uciToSan: ход с фигурой и взятием → SAN с x', () => {
    // r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3
    // Nxe5: Nf3 → e5 берёт чёрную пешку.
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    expect(uciToSan('f3e5', fen)).toBe('Nxe5');
  });

  it('uciToSan: нелегальный ход → fallback UCI', () => {
    expect(
      uciToSan('a1a8', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
    ).toBe('a1a8');
  });

  it('uciToSan: пустой/короткий → возвращает as-is', () => {
    expect(uciToSan('', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe('');
    expect(uciToSan('e2', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe('e2');
  });

  it('blunderUciToSan: восстанавливает before-FEN и даёт SAN', () => {
    // post-blunder FEN: чёрные ходят, белые только что сыграли f1f4 (зевок Rf4).
    // Из реального пазла KS-2466.
    const postFen = '6k1/7p/b3p1p1/p2pPP2/2pB1R2/2Pn2QP/qr4BN/6K1 b - - 0 30';
    expect(blunderUciToSan('f1f4', postFen)).toBe('Rf4');
  });

  it('blunderUciToSan: невалидный UCI → fallback', () => {
    expect(blunderUciToSan('xx', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe('xx');
    expect(blunderUciToSan('', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe('');
  });
});

/**
 * KS-2505: cpFromScore — нормализация cp/mate в одно cp-число для
 * downstream-классификатора (KS-2504 classifyMove).
 */
describe('cpFromScore KS-2505', () => {
  it('cp pass-through (положительный)', () => {
    expect(cpFromScore({ type: 'cp', value: 50 })).toBe(50);
  });
  it('cp pass-through (отрицательный)', () => {
    expect(cpFromScore({ type: 'cp', value: -250 })).toBe(-250);
  });
  it('cp = 0', () => {
    expect(cpFromScore({ type: 'cp', value: 0 })).toBe(0);
  });
  it('mate +N → +100000', () => {
    expect(cpFromScore({ type: 'mate', value: 1 })).toBe(100000);
    expect(cpFromScore({ type: 'mate', value: 5 })).toBe(100000);
  });
  it('mate −N → −100000', () => {
    expect(cpFromScore({ type: 'mate', value: -1 })).toBe(-100000);
    expect(cpFromScore({ type: 'mate', value: -7 })).toBe(-100000);
  });
});
