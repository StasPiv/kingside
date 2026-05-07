import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { renderWithProviders, screen } from '../../test/test-utils';
import { PlayVsEngineRunner, uciToSan, blunderUciToSan } from './PlayVsEngineRunner';
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
    // KS-2473: + pre-analyze, поэтому отдаём 2 ответа.
    const engine = new ScriptedEngine([
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

  it('KS-2473: post-mortem bestmoveHint = PV1 в позиции ДО user-хода (lose-сценарий)', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.1,
        halfMovesN: 6,
      },
    });
    // pre-analyze (FEN ДО user-хода, white to move): рекомендует d2d4 cp +50.
    // post-analyze (FEN после user-хода, black to move, POV черных) cp +800
    //   → wdl_engine ≈ +0.88, wdl_user = -0.88 < failThreshold=0.1 → lose-wdl.
    const engine = new ScriptedEngine([
      result(line({ type: 'cp', value: 50 }, ['d2d4'])), // pre-analyze: best=d2d4
      result(line({ type: 'cp', value: 800 }, ['d7d5'])), // post-analyze
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    // user сыграл e2-e4, лучший ход (по pre-analyze) = d2d4.
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(
        screen.getByTestId('puzzle-engine-runner').getAttribute('data-state'),
      ).toBe('lose');
    });
    // Подождать, пока pre-analyze допишется (фон).
    const hint = await waitFor(() => {
      const el = screen.queryByTestId('puzzle-engine-bestmove-hint');
      if (!el) throw new Error('hint not yet rendered');
      if (el.getAttribute('data-kind') !== 'user') throw new Error('hint kind not user yet');
      return el;
    });
    // played = e4 (e2-e4 в SAN), best = d4 (d2-d4).
    expect(hint.textContent).toMatch(/e4/);
    expect(hint.textContent).toMatch(/d4/);
    // Текст должен соответствовать ключу bestmoveDiff (played != best).
    expect(hint.textContent).toMatch(/best move was|лучше было/i);
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

  // KS-2486: ссылка «Open in Workshop» — всегда видна, href с FEN.
  it('KS-2486: рендерит puzzle-engine-workshop-link с href=/analysis?fen=<currentFen>', async () => {
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
    // href совпадает с /analysis?fen=<encoded>, FEN из puzzle (до ходов).
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
