import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { renderWithProviders, screen } from '../../test/test-utils';
import {
  PlayVsEngineRunner,
  uciToSan,
  blunderUciToSan,
  cpFromScore,
  formatBlunderMoveWithNumber,
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
  private searchmovesQueue: AnalysisResult[];

  constructor(
    queue: AnalysisResult[],
    /**
     * KS-3380 full: ответы для extra-analyze, который PVE-runner
     * вызывает после хода игрока через `analyze(fenBefore, ..., searchmoves=[playedUci])`.
     * Тесту удобнее держать эти ответы отдельно — общая `queue` остаётся
     * как раньше (INITIAL + pre-analyze + post-analyze + ...).
     * По умолчанию пустая; runner получит empty fallback, snapshot
     * запишется с `cpAfter=null`. Best-case (playedUci===bestUci)
     * extra НЕ вызывается, очередь не нужна.
     */
    searchmovesQueue: AnalysisResult[] = [],
  ) {
    this.queue = [...queue];
    this.searchmovesQueue = [...searchmovesQueue];
  }

  async init(): Promise<void> { /* no-op */ }
  setOption(): void { /* no-op */ }

  async analyze(
    _fen: string,
    _depth: number,
    _multiPv: number,
    _movetimeMs?: number,
    _nodes?: number,
    searchmoves?: ReadonlyArray<string>,
  ): Promise<AnalysisResult> {
    const source =
      searchmoves && searchmoves.length > 0
        ? this.searchmovesQueue
        : this.queue;
    const next = source.shift();
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

  // KS-3391: live-анализ в state-machine тестах не стримим — no-op, чтобы
  // не трогать основную `queue` (её аккаунтинг рассчитан на дискретные
  // analyze: INITIAL + pre + post + ...). Полоса шансов из live-потока
  // покрыта отдельными тестами WdlChancesBar и engineAdapter.
  async analyzeLive(): Promise<void> { /* no-op */ }
  stop(): void { /* no-op */ }

  destroy(): void { /* no-op */ }
}

function line(
  score: InfoLine['score'],
  pv: string[],
  depth = 12,
  multipv = 1,
  wdl?: { w: number; d: number; l: number },
): InfoLine {
  return { depth, multipv, score, pv, ...(wdl ? { wdl } : {}) };
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
    // KS-2739: проверка что moves[] передан и содержит pre-analyze
    // snapshot первого user-хода. Раньше submitOnce захватывал
    // userBestLog через `useCallback([userBestLog])`, и при race с
    // pre-analyze (которая делает `setUserBestLog(prev => [...prev, ...])`)
    // в submitOnce попадало старое значение `[]`.
    expect(arg.moves).toHaveLength(1);
    expect(arg.moves[0].playedUci).toBe('e2e4');
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
    // KS-2739: lose-wdl тоже должен везти moves[]
    expect(arg.moves).toHaveLength(1);
    expect(arg.moves[0].playedUci).toBe('e2e4');
  });

  it('win по итогу N user-ходов: финал ПОСЛЕ N-го user-хода, без engine reply', async () => {
    // KS-2754 follow-up: новое правило — после N user-ходов финиш без
    // engine reply (где N = ceil(halfMovesN/2)). halfMovesN=2 → N=1
    // user-ход. После него: финиш по effWdlUser (≥winThreshold → win).
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 2,
      },
    });
    // 1) Pre-analyze user move 1 — не финал.
    // 2) Post-analyze позиции после user-хода: POV engine cp=-800
    //    → wdl_user POV ≈ +0.92 ≥ winThreshold(0.5) → win.
    //    Engine bestmove НЕ применяется, final analyze не нужен.
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 100 }, ['e2e4'])), // pre-analyze user move 1
      result(line({ type: 'cp', value: -800 }, ['e7e5'])), // post-analyze 1
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
    // halfMovesPlayed==1 (только user-ход, без engine reply).
    expect(arg.halfMovesPlayed).toBe(1);
    expect(arg.finalWdl).toBeGreaterThanOrEqual(0.5);
    expect(arg.moves).toHaveLength(1);
    expect(arg.moves[0].playedUci).toBe('e2e4');
    // KS-2754: engineUci последнего user-хода остаётся null (движок
    // не отвечал) — задача засчитывается user-ходом.
    expect(arg.moves[0].engineUci).toBeNull();
  });

  it('KS-2969: promotion-ход — playedUci содержит выбранную фигуру (b7b8q)', async () => {
    // FEN из репро задачи KS-2969: после хода `b7b8` нужно promotion-
    // суффикс. Раньше playedUci был «b7b8» без фигуры → API 400.
    const puzzle = makePuzzle({
      fen: '8/1P1b1p1p/5kp1/8/2Pr3P/2n2P2/4RKP1/8 w - - 1 41',
      playVsEngine: {
        blunderMove: 'b7b8q',
        wdlAfterBlunder: 0.9,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
      },
    });
    // Engine после промоушна белых видит mate против чёрных → win-engine-resign.
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 800 }, ['b7b8q'])), // pre-analyze
      result(line({ type: 'mate', value: -2 }, ['c3a2'])), // post-analyze
    ]);
    const onSubmit = vi.fn();
    const { container } = renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} onSubmit={onSubmit} engineFactory={() => engine} />,
    );
    // user ход b7-b8 → открывается модалка выбора фигуры.
    (screen.getByTestId('fire-square-b7') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-b8') as HTMLButtonElement).click();
    // Модалка отрендерилась — выбираем ферзя.
    await waitFor(() => {
      expect(screen.getByTestId('puzzle-promotion-overlay')).toBeInTheDocument();
    });
    (screen.getByTestId('promotion-choice-q') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="puzzle-engine-runner"]')?.getAttribute('data-state')).toBe('win');
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const arg = onSubmit.mock.calls[0][0];
    // KS-2969: главная проверка — playedUci содержит суффикс фигуры.
    // Backend требует «b7b8q», а не голое «b7b8» (illegal-move 400).
    expect(arg.moves).toHaveLength(1);
    expect(arg.moves[0].playedUci).toBe('b7b8q');
  });

  it('KS-2970: даже при autoPromoteToQueen=true в localStorage модалка показывается в precision-раннере', async () => {
    // KS-2970 ограничивает автопромоушн режимом игры (/game/*).
    // В пазлах настройка должна игнорироваться — модалка показывается всегда.
    localStorage.setItem('autoPromoteToQueen', 'true');
    const puzzle = makePuzzle({
      fen: '8/1P1b1p1p/5kp1/8/2Pr3P/2n2P2/4RKP1/8 w - - 1 41',
      playVsEngine: {
        blunderMove: 'b7b8q',
        wdlAfterBlunder: 0.9,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
      },
    });
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 800 }, ['b7b8q'])),
      result(line({ type: 'mate', value: -2 }, ['c3a2'])),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    (screen.getByTestId('fire-square-b7') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-b8') as HTMLButtonElement).click();
    // Модалка обязана появиться, даже если в localStorage autoPromoteToQueen=true.
    await waitFor(() => {
      expect(screen.getByTestId('puzzle-promotion-overlay')).toBeInTheDocument();
    });
    localStorage.removeItem('autoPromoteToQueen');
  });

  it('KS-2969: promotion-ход — выбор НЕ ферзя (под-промоушн в коня)', async () => {
    // Тот же FEN, но юзер выбирает коня (`n`) — playedUci='b7b8n'.
    const puzzle = makePuzzle({
      fen: '8/1P1b1p1p/5kp1/8/2Pr3P/2n2P2/4RKP1/8 w - - 1 41',
      playVsEngine: {
        blunderMove: 'b7b8n',
        wdlAfterBlunder: 0.9,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
      },
    });
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 800 }, ['b7b8n'])),
      result(line({ type: 'mate', value: -2 }, ['c3a2'])),
    ]);
    const onSubmit = vi.fn();
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} onSubmit={onSubmit} engineFactory={() => engine} />,
    );
    (screen.getByTestId('fire-square-b7') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-b8') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(screen.getByTestId('puzzle-promotion-overlay')).toBeInTheDocument();
    });
    (screen.getByTestId('promotion-choice-n') as HTMLButtonElement).click();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.moves[0].playedUci).toBe('b7b8n');
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
    // KS-3380: extra POV user даёт cp=-500 → variation block рендерится
    // т.к. classification = inaccuracy/mistake/blunder.
    const engine = new ScriptedEngine(
      [
        INITIAL_ANALYZE(),
        result(line({ type: 'cp', value: 50 }, ['d2d4'])), // pre: best=d2d4
        result(line({ type: 'cp', value: 800 }, ['d7d5'])), // post → lose-wdl
      ],
      [result(line({ type: 'cp', value: -500 }, ['e2e4']))],
    );
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
      const row = screen.queryByTestId('post-game-review-move-0');
      if (!row) throw new Error('row not yet built');
      const cls = row.getAttribute('data-class');
      if (cls === 'good') throw new Error('still graceful good');
    });
    const row = screen.getByTestId('post-game-review-move-0');
    expect(row.textContent).toMatch(/e4/); // played
    const best = screen.getByTestId('post-game-review-variation-0');
    // KS-2534: вариант с лучшим ходом теперь в формате «(1. d4!)»
    // вместо старого «Best was: d4». Текст содержит SAN и «!».
    expect(best.textContent).toMatch(/d4!/);
    expect(best.textContent).toMatch(/^\(1\./);
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
    // KS-3380: cpAfter теперь из pre-frame extra-analyze (POV user).
    const engine = new ScriptedEngine(
      [
        INITIAL_ANALYZE(),
        result(line({ type: 'cp', value: 50 }, ['d2d4'])), // pre cpBefore=+50, PV1=d2d4 != played
        result(line({ type: 'cp', value: 800 }, ['d7d5'])), // post (для engine reply, НЕ для snapshot)
      ],
      [result(line({ type: 'cp', value: -800 }, ['e2e4']))], // extra POV user cpAfter=-800
    );
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
      const row = screen.queryByTestId('post-game-review-move-0');
      if (!row || row.getAttribute('data-class') !== 'blunder') {
        throw new Error('not yet blunder');
      }
    });
    const row = screen.getByTestId('post-game-review-move-0');
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
    // KS-3380: extra-analyze для e2e4 (POV user) даёт mate -2 → cpAfter=-100000.
    const engine = new ScriptedEngine(
      [
        INITIAL_ANALYZE(),
        result(line({ type: 'cp', value: 50 }, ['d2d4'])),
        result(line({ type: 'mate', value: 2 }, ['d7d5'])),
      ],
      [result(line({ type: 'mate', value: -2 }, ['e2e4']))],
    );
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
      const row = screen.queryByTestId('post-game-review-move-0');
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
    // KS-3380: extra cpAfter=-800 (POV user, без инверсии).
    const engine = new ScriptedEngine(
      [
        INITIAL_ANALYZE(),
        result(line({ type: 'mate', value: 3 }, ['d2d4'])),
        result(line({ type: 'cp', value: 800 }, ['d7d5'])),
      ],
      [result(line({ type: 'cp', value: -800 }, ['e2e4']))],
    );
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
      const row = screen.queryByTestId('post-game-review-move-0');
      if (!row || row.getAttribute('data-class') !== 'blunder') {
        throw new Error('not yet blunder');
      }
    });
  });

  it('KS-3369: initial — replay-кнопка рендерится при known blunder; progress=N', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        // KS-3365: для replay-кнопки нужен fenBeforeBlunder.
        fenBeforeBlunder:
          'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
      },
    });
    const engine = new ScriptedEngine([
      result(line({ type: 'cp', value: 30 }, ['e2e4'])),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    // KS-3369: плашка `puzzle-engine-blunder-hint` удалена; роль
    // «зевок отыгран» закрывает replay-кнопка (KS-3366).
    expect(
      screen.queryByTestId('puzzle-engine-blunder-hint'),
    ).not.toBeInTheDocument();
    const replay = screen.getByTestId('puzzle-engine-replay-blunder');
    expect(replay).toBeInTheDocument();
    expect(replay.getAttribute('data-blunder-known')).toBe('true');
    expect(screen.getByTestId('puzzle-engine-progress').textContent).toMatch(/6/);
  });

  /**
   * KS-2732 / KS-3369: пазл без blunderMove (forced-line попал в PVE
   * через защитный fromPrecision-override) — ни плашки, ни replay-
   * кнопки. Только board + progress.
   */
  it('KS-3369: пазл без blunderMove → replay-кнопка не рендерится', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: '',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
      },
    });
    const engine = new ScriptedEngine([
      result(line({ type: 'cp', value: 30 }, ['e2e4'])),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    expect(
      screen.queryByTestId('puzzle-engine-blunder-hint'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('puzzle-engine-replay-blunder'),
    ).not.toBeInTheDocument();
  });

  it('KS-2527: initial analyze c wdl → latestWdl POV user без flip (data-latest-wdl)', async () => {
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
    const engine = new ScriptedEngine([
      // initial analyze на FEN решателя (=user) → POV user без flip.
      result(line({ type: 'cp', value: 50 }, ['e2e4'], 12, 1, { w: 700, d: 200, l: 100 })),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    await waitFor(() => {
      const v = screen
        .getByTestId('puzzle-engine-runner')
        .getAttribute('data-latest-wdl');
      if (v !== '700,200,100') throw new Error(`got ${v}`);
    });
  });

  it('KS-2527: initial analyze без wdl → latestWdl=null (data-latest-wdl=пусто)', async () => {
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
    const engine = new ScriptedEngine([
      result(line({ type: 'cp', value: 25 }, ['e2e4'])), // без wdl
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    // Дожидаемся, пока initial analyze отработает: evalLines > 0.
    await waitFor(() => {
      const lines = Number(
        screen
          .getByTestId('puzzle-engine-runner')
          .getAttribute('data-eval-lines'),
      );
      if (lines <= 0) throw new Error('initial not done yet');
    });
    // Без wdl latestWdl остаётся null → атрибут пустой.
    expect(
      screen
        .getByTestId('puzzle-engine-runner')
        .getAttribute('data-latest-wdl'),
    ).toBe('');
  });

  it('KS-2527: post-analyze wdl POV соперника → flipWdl даёт POV user', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.1,
        halfMovesN: 6,
      },
    });
    // post-analyze cp+800 → engine думает что у него +0.88 → user проиграл.
    // wdl POV opp = {w:850, d:120, l:30} → POV user = {w:30, d:120, l:850}.
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 50 }, ['d2d4'])), // pre, без wdl
      result(line({ type: 'cp', value: 800 }, ['d7d5'], 12, 1, { w: 850, d: 120, l: 30 })),
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
    // После post-analyze data-latest-wdl = "30,120,850" (флип w↔l).
    await waitFor(() => {
      const v = screen
        .getByTestId('puzzle-engine-runner')
        .getAttribute('data-latest-wdl');
      if (v !== '30,120,850') throw new Error(`got ${v}`);
    });
  });

  it('KS-2519: initial analyze на белый side-to-move → data-eval-side=w', async () => {
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
    const engine = new ScriptedEngine([
      result(line({ type: 'cp', value: 25 }, ['e2e4'])),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    // initial analyze пишет evalSide = ходящему в puzzle.fen ('w').
    await waitFor(() => {
      expect(
        screen.getByTestId('puzzle-engine-runner').getAttribute('data-eval-side'),
      ).toBe('w');
    });
  });

  it('KS-2519: пазл с чёрным решателем → initial analyze data-eval-side=b', async () => {
    const puzzle = makePuzzle({
      // FEN с side-to-move='b': чёрные ходят (решатель чёрный).
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      playVsEngine: {
        blunderMove: 'g1f3',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 6,
      },
    });
    const engine = new ScriptedEngine([
      result(line({ type: 'cp', value: 25 }, ['e7e5'])),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId('puzzle-engine-runner').getAttribute('data-eval-side'),
      ).toBe('b');
    });
  });

  it('KS-2519: после user-хода post-analyze → data-eval-side флипается на соперника', async () => {
    // Стартовый side-to-move = 'w' (юзер белый). После e2-e4 → side='b'.
    const puzzle = makePuzzle({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
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
    // После initial analyze evalSide='w'.
    await waitFor(() => {
      expect(
        screen.getByTestId('puzzle-engine-runner').getAttribute('data-eval-side'),
      ).toBe('w');
    });
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(
        screen.getByTestId('puzzle-engine-runner').getAttribute('data-state'),
      ).toBe('lose');
    });
    // post-analyze был на FEN после e2-e4 → side-to-move='b'.
    expect(
      screen.getByTestId('puzzle-engine-runner').getAttribute('data-eval-side'),
    ).toBe('b');
  });

  it('KS-2686: legacy-пазл (без wdlAfter) lose → summary не рендерится, остаётся только reasonLabel', async () => {
    // KS-2686: sigmoid-fallback из cp удалён. Если у пазла нет wdlAfter
    // или движок не отдал wdl — карточка с тремя строками не рендерится,
    // внешний reasonLabel («Advantage lost») остаётся единственным.
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.1,
        halfMovesN: 6,
      },
    });
    // KS-3380: extra cp=-500 POV user.
    const engine = new ScriptedEngine(
      [
        INITIAL_ANALYZE(),
        result(line({ type: 'cp', value: 50 }, ['d2d4'])),
        result(line({ type: 'cp', value: 800 }, ['d7d5'])),
      ],
      [result(line({ type: 'cp', value: -500 }, ['e2e4']))],
    );
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
    // Карточки нет (нет wdlAfter у пазла).
    expect(
      screen.queryByTestId('puzzle-engine-wdl-summary'),
    ).toBeNull();
    // KS-3018: вместо бинарной плашки «You lost the advantage» теперь
    // рендерится PrecisionScoreBlock. Для legacy-теста с 1 ходом (<2 →
    // §3.2) score=null → null-state (data-tone="unavailable").
    const scoreBlock = screen.getByTestId('precision-score-block');
    // KS-3033 (shared MIN_HALF_MOVES_FOR_SCORE=1): 1-полуход теперь
    // получает реальный score; tone не unavailable.
    expect(scoreBlock.getAttribute('data-tone')).not.toBe('unavailable');
  });

  it('KS-2686: legacy preserved (без wdlAfter) → summary не рендерится, reasonLabel «Advantage preserved»', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 2,
      },
    });
    // KS-2754 follow-up: post-analyze cp=-800 → wdl_user≥winThreshold,
    // финиш после первого user-хода (target=ceil(2/2)=1) без engine reply.
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 100 }, ['e2e4'])),
      result(line({ type: 'cp', value: -800 }, ['e7e5'])),
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
    expect(
      screen.queryByTestId('puzzle-engine-wdl-summary'),
    ).toBeNull();
    // KS-3018: PrecisionScoreBlock с null-state (1 ход < §3.2 минимума).
    const scoreBlock = screen.getByTestId('precision-score-block');
    // KS-3033 (shared MIN_HALF_MOVES_FOR_SCORE=1): 1-полуход теперь
    // получает реальный score; tone не unavailable.
    expect(scoreBlock.getAttribute('data-tone')).not.toBe('unavailable');
  });

  it('KS-2528: primary path — три строки Win/Draw/Loss с per-mille→% и сigned-дельтой', async () => {
    // start (puzzle.playVsEngine.wdlAfter, POV solver=user):
    //   {w:850, d:130, l:20} → 85/13/2 %.
    // final (latestWdl POV user, после post-analyze с inversion):
    //   engine cp=+800 + wdl POV opp {w:780, d:200, l:20} → flip
    //   POV user {w:20, d:200, l:780} → 2/20/78 %.
    // delta_W = 2−85 = −83. delta_L = 78−2 = +76.
    // (start.w − final.w) − (start.l − final.l) = 83 − (−76) = 159 > 0
    //   → lost.
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.1,
        halfMovesN: 6,
        wdlAfter: { w: 850, d: 130, l: 20 },
      },
    });
    // KS-3380: extra POV user, WDL «потеряно» 2/20/78.
    const engine = new ScriptedEngine(
      [
        INITIAL_ANALYZE(),
        result(line({ type: 'cp', value: 50 }, ['d2d4'])),
        result(line({ type: 'cp', value: 800 }, ['d7d5'], 12, 1, {
          w: 780,
          d: 200,
          l: 20,
        })),
      ],
      [
        result(
          line({ type: 'cp', value: -500 }, ['e2e4'], 12, 1, {
            w: 20,
            d: 200,
            l: 780,
          }),
        ),
      ],
    );
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
    // Дожидаемся, пока latestWdl попадёт в state и summary перерисуется
    // в primary-режиме.
    await waitFor(() => {
      const sum = screen.getByTestId('puzzle-engine-wdl-summary');
      if (sum.getAttribute('data-mode') !== 'permille') {
        throw new Error('still on signed fallback');
      }
    });
    const summary = screen.getByTestId('puzzle-engine-wdl-summary');
    expect(summary.getAttribute('data-preserved')).toBe('false');
    expect(summary.getAttribute('data-start-w')).toBe('85');
    expect(summary.getAttribute('data-start-d')).toBe('13');
    expect(summary.getAttribute('data-start-l')).toBe('2');
    expect(summary.getAttribute('data-final-w')).toBe('2');
    expect(summary.getAttribute('data-final-d')).toBe('20');
    expect(summary.getAttribute('data-final-l')).toBe('78');
    // KS-3018: бинарная плашка заменена на PrecisionScoreBlock (звёзды).
    // В этом кейсе 1 user-полуход → score=null (null-state).
    const scoreBlock = screen.getByTestId('precision-score-block');
    // KS-3033 (shared MIN_HALF_MOVES_FOR_SCORE=1): 1-полуход теперь
    // получает реальный score; tone не unavailable.
    expect(scoreBlock.getAttribute('data-tone')).not.toBe('unavailable');

    // Каждая строка Win/Draw/Loss есть в DOM.
    const winRow = screen.getByTestId('puzzle-engine-wdl-row-win');
    const drawRow = screen.getByTestId('puzzle-engine-wdl-row-draw');
    const lossRow = screen.getByTestId('puzzle-engine-wdl-row-loss');
    expect(winRow.textContent).toMatch(/85% .+ 2%/); // start → final
    expect(winRow.textContent).toMatch(/−83%/); // delta with U+2212
    expect(drawRow.textContent).toMatch(/13% .+ 20%/);
    expect(drawRow.textContent).toMatch(/\+7%/);
    expect(lossRow.textContent).toMatch(/2% .+ 78%/);
    expect(lossRow.textContent).toMatch(/\+76%/);
  });

  it('KS-2529: snapshot primary-summary с тремя строками Win/Draw/Loss', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.1,
        halfMovesN: 6,
        wdlAfter: { w: 850, d: 130, l: 20 },
      },
    });
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 50 }, ['d2d4'])),
      result(line({ type: 'cp', value: 800 }, ['d7d5'], 12, 1, {
        w: 780,
        d: 200,
        l: 20,
      })),
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
      const sum = screen.getByTestId('puzzle-engine-wdl-summary');
      if (sum.getAttribute('data-mode') !== 'permille') {
        throw new Error('not on primary mode yet');
      }
    });
    const summary = screen.getByTestId('puzzle-engine-wdl-summary');
    // Snapshot фиксирует структуру (атрибуты, обёртки, тексты строк
    // Win/Draw/Loss с переводом и формат «label: X% → Y% (delta)»).
    expect(summary).toMatchSnapshot();
  });

  it('KS-2535: header summary одинаковый со state — state=win + delta>0 в fallback → preserved', async () => {
    // wdlAfterBlunder=0.96 (старт ≈ 98%), final wdlUser=+0.14 (≈ 57%).
    // delta_pct = 98 − 57 = 41 > 0, но WDL-объект решает state=win.
    // До KS-2535 header брался из дельты → «Advantage lost».
    // Теперь — из state → «Advantage preserved».
    //
    // KS-2968: после введения drop-критерия baseline → final больше
    // 15 п.п. квалифицируется как «потеряно» (даже если signed-WDL
    // формально в плюсе). Чтобы тест продолжал ловить именно фикс
    // KS-2535 (header следует state'у при PRESERVED исходе), сужаем
    // расхождение baseline ↔ final до значения в пределах порога.
    // baseline берём из initial pre-analyze (с WDL) — clientBaselineWdl.
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.7,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 2,
        wdlAfter: { w: 850, d: 150, l: 0 },
      },
    });
    // halfMovesN=2 → user-ход → engine-ход → final analyze.
    // clientBaseline (из initial pre-analyze WDL) = {850,150,0}.
    // final POV user {800,150,50} → drop=850-800=50 ‰ < 150 ‰ → preserved.
    // signedWdl(final)=(800-50)/1000=+0.75 ≥ winThreshold → state=win.
    const engine = new ScriptedEngine([
      // KS-2960/KS-2968: initial pre-analyze поставляет clientBaselineWdl.
      result(line({ type: 'cp', value: 80 }, ['e2e4'], 12, 1, {
        w: 850,
        d: 150,
        l: 0,
      })),
      result(line({ type: 'cp', value: 80 }, ['e2e4'])), // pre
      result(line({ type: 'cp', value: -50 }, ['e7e5'], 12, 1, {
        w: 50,
        d: 150,
        l: 800,
      })), // post POV opp (user winning)
      result(line({ type: 'cp', value: 50 }, ['d2d4'], 12, 1, {
        w: 800,
        d: 150,
        l: 50,
      })), // final POV user — winning по WDL, drop в пределах порога KS-2968.
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
    // KS-3018: бинарная плашка заменена на PrecisionScoreBlock. В этом
    // кейсе 1 user-полуход → score=null (null-state).
    const scoreBlock = screen.getByTestId('precision-score-block');
    // KS-3033 (shared MIN_HALF_MOVES_FOR_SCORE=1): 1-полуход теперь
    // получает реальный score; tone не unavailable.
    expect(scoreBlock.getAttribute('data-tone')).not.toBe('unavailable');
    expect(summary.getAttribute('data-preserved')).toBe('true');
    // KS-2686: режим только permille (sigmoid-fallback удалён).
    expect(summary.getAttribute('data-mode')).toBe('permille');
  });

  it('KS-2533: при идеальной игре с WDL POV user {1000,0,0} в финале → state=win (а не lose-wdl)', async () => {
    // Симулируем баг: signed cp small (sigmoid < winThreshold), но
    // движок отдал WDL {1000,0,0} → реально позиция выигрышная.
    // До KS-2533 win/lose решалось по signed → lose-wdl. После — по
    // signedWdlFromObj → win.
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 2,
        wdlAfter: { w: 1000, d: 0, l: 0 },
      },
    });
    // halfMovesN=2 → user-ход → engine-ход → final analyze.
    // final POV user: cp=+50 (sigmoid≈+0.124, < winThreshold!) но
    // wdl {1000,0,0} → effectiveSignedWdl = +1.0 ≥ 0.5 → win.
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 80 }, ['e2e4'])), // pre
      result(line({ type: 'cp', value: -50 }, ['e7e5'], 12, 1, {
        w: 0,
        d: 0,
        l: 1000,
      })), // post POV opp
      // final POV user: «слабый» cp но абсолютный WDL.
      result(line({ type: 'cp', value: 50 }, ['d2d4'], 12, 1, {
        w: 1000,
        d: 0,
        l: 0,
      })),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
    );
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => {
      const st = screen
        .getByTestId('puzzle-engine-runner')
        .getAttribute('data-state');
      // Должен быть win, а не lose.
      if (st !== 'win') throw new Error(`expected win, got ${st}`);
    });
    expect(
      screen.getByTestId('puzzle-engine-runner').getAttribute('data-reason'),
    ).toBe('win');
    // Внутренний header WDL-summary тоже preserved.
    await waitFor(() => {
      const sum = screen.getByTestId('puzzle-engine-wdl-summary');
      if (sum.getAttribute('data-preserved') !== 'true') {
        throw new Error('expected preserved=true');
      }
    });
  });

  it('KS-2528: primary preserved — header «Advantage preserved» когда W не упало больше L', async () => {
    // start {w:200, d:600, l:200} → 20/60/20.
    // start = {w:900, d:80, l:20} → 90/8/2.
    // final = same → 90/8/2. Δ=0/0/0 → preserved + signedWdl=0.88 ≥ winThreshold.
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 2,
        wdlAfter: { w: 900, d: 80, l: 20 },
      },
    });
    // halfMovesN=2: user-ход → engine-ход → final analyze.
    // final analyze возвращает score POV user и wdl POV user.
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 100 }, ['e2e4'])), // pre
      // post-analyze POV opp: solver winning → opp WDL low.
      result(line({ type: 'cp', value: -300 }, ['e7e5'], 12, 1, {
        w: 20,
        d: 80,
        l: 900,
      })),
      // final analyze POV user: signedWdl = (900-20)/1000 = 0.88 → win.
      result(line({ type: 'cp', value: 600 }, ['d2d4'], 12, 1, {
        w: 900,
        d: 80,
        l: 20,
      })),
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
    await waitFor(() => {
      const sum = screen.getByTestId('puzzle-engine-wdl-summary');
      if (sum.getAttribute('data-mode') !== 'permille') {
        throw new Error('not on primary mode yet');
      }
    });
    const summary = screen.getByTestId('puzzle-engine-wdl-summary');
    expect(summary.getAttribute('data-preserved')).toBe('true');
    // KS-3018: бинарная плашка заменена на PrecisionScoreBlock. В этом
    // кейсе 1 user-полуход → score=null (null-state).
    const scoreBlock = screen.getByTestId('precision-score-block');
    // KS-3033 (shared MIN_HALF_MOVES_FOR_SCORE=1): 1-полуход теперь
    // получает реальный score; tone не unavailable.
    expect(scoreBlock.getAttribute('data-tone')).not.toBe('unavailable');
    // Все три строки, дельты — `(0%)` без знака.
    expect(
      screen.getByTestId('puzzle-engine-wdl-row-win').textContent,
    ).toMatch(/\(0%\)/);
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
      const el = screen.queryByTestId('post-game-review-move-0');
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
    // KS-3380: pre cp=+50 (PV1=d2d4 != played), extra cp=-800 POV user.
    // cp-loss=850 → blunder.
    const engine = new ScriptedEngine(
      [
        INITIAL_ANALYZE(),
        result(line({ type: 'cp', value: 50 }, ['d2d4'])),
        result(line({ type: 'cp', value: 800 }, ['d7d5'])),
      ],
      [result(line({ type: 'cp', value: -800 }, ['e2e4']))],
    );
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
      const row = el.querySelector('[data-testid="post-game-review-move-0"]');
      if (!row) throw new Error('row not yet built');
      const cls = row.getAttribute('data-class');
      // Дожидаемся, пока классификация уже опирается на cpAfter (а не
      // graceful good из-за null).
      if (cls === 'good') throw new Error('still graceful good');
      return el;
    });
    const row = review.querySelector(
      '[data-testid="post-game-review-move-0"]',
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

  /**
   * KS-2960: baseline WDL стартовой позиции должен браться из локального
   * SF (initial pre-analyze), а не из серверного `puzzle.playVsEngine.wdlAfter`.
   * Иначе при расхождении gen-time vs run-time UI показывал «удержано»/«потеряно»
   * с неверными `start`-процентами.
   */
  describe('KS-2960 — клиентский baseline WDL вместо серверного', () => {
    it('clientBaselineWdl из initial analyze переопределяет puzzle.playVsEngine.wdlAfter в summary', async () => {
      // Сервер говорит 100% win — серверный wdlAfter сильно завышен.
      // Клиентский SF на той же позиции видит 50/30/20.
      const puzzle = makePuzzle({
        playVsEngine: {
          blunderMove: 'd2d4',
          wdlAfterBlunder: 0.6,
          winThreshold: 0.5,
          failThreshold: 0.1,
          halfMovesN: 6,
          // Серверный baseline, которому НЕ должны доверять:
          wdlAfter: { w: 1000, d: 0, l: 0 },
        },
      });
      const engine = new ScriptedEngine([
        // KS-2960: initial pre-analyze отдаёт реальный WDL клиента.
        result(
          line({ type: 'cp', value: 0 }, ['e2e4'], 12, 1, {
            w: 500,
            d: 300,
            l: 200,
          }),
        ),
        // pre-analyze user move 1 (без wdl — не влияет на summary).
        result(line({ type: 'cp', value: 50 }, ['d2d4'])),
        // post-analyze: lose-сценарий, чтобы дойти до summary.
        result(
          line({ type: 'cp', value: 800 }, ['d7d5'], 12, 1, {
            w: 780,
            d: 200,
            l: 20,
          }),
        ),
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
        const sum = screen.getByTestId('puzzle-engine-wdl-summary');
        if (sum.getAttribute('data-mode') !== 'permille') {
          throw new Error('still on signed fallback');
        }
      });
      const summary = screen.getByTestId('puzzle-engine-wdl-summary');
      // start берётся из клиентского baseline (500/300/200 → 50/30/20),
      // НЕ из серверного wdlAfter (1000/0/0 → 100/0/0).
      expect(summary.getAttribute('data-start-w')).toBe('50');
      expect(summary.getAttribute('data-start-d')).toBe('30');
      expect(summary.getAttribute('data-start-l')).toBe('20');
    });

    it('KS-2968 — live кейс (start 92/8/0 → final 50/50/0): preserved=false, плашка «потеряно»', async () => {
      // Жалоба пользователя на проде (KS-2968): три хода `!`, signed-WDL
      // финала ровно на winThreshold (0.5), формально «в плюсе», но win%
      // упал на 42 п.п. — это потеря преимущества. До KS-2968 раннер
      // ставил «удержано» (effWdl >= winThreshold выигрывал, drop
      // игнорировался).
      const puzzle = makePuzzle({
        playVsEngine: {
          blunderMove: 'd2d4',
          wdlAfterBlunder: 0.92,
          winThreshold: 0.5,
          failThreshold: 0,
          halfMovesN: 2, // 1 user-ход + final (без engine-ответа)
          wdlAfter: { w: 920, d: 80, l: 0 },
        },
      });
      const engine = new ScriptedEngine([
        // initial pre-analyze: clientBaselineWdl = 92/8/0.
        result(
          line({ type: 'cp', value: 200 }, ['e2e4'], 12, 1, {
            w: 920,
            d: 80,
            l: 0,
          }),
        ),
        // pre-analyze user move (для snapshot bestUci/wdlBefore).
        result(
          line({ type: 'cp', value: 200 }, ['e2e4'], 12, 1, {
            w: 920,
            d: 80,
            l: 0,
          }),
        ),
        // post-analyze POV opp (user winning по signed, но WDL упал):
        // flipWdl → POV user {500, 500, 0} → signed=+0.5 (ровно winThreshold).
        result(
          line({ type: 'cp', value: -50 }, ['e7e5'], 12, 1, {
            w: 0,
            d: 500,
            l: 500,
          }),
        ),
      ]);
      renderWithProviders(
        <PlayVsEngineRunner puzzle={puzzle} engineFactory={() => engine} />,
      );
      (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
      (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
      // С KS-2968: drop=420 ‰ > 150 ‰ → state=lose, plашка «потеряно».
      await waitFor(() => {
        expect(
          screen.getByTestId('puzzle-engine-runner').getAttribute('data-state'),
        ).toBe('lose');
      });
      await waitFor(() => {
        const sum = screen.getByTestId('puzzle-engine-wdl-summary');
        if (sum.getAttribute('data-mode') !== 'permille') {
          throw new Error('still on signed fallback');
        }
      });
      const summary = screen.getByTestId('puzzle-engine-wdl-summary');
      expect(summary.getAttribute('data-preserved')).toBe('false');
      expect(summary.getAttribute('data-start-w')).toBe('92');
      expect(summary.getAttribute('data-final-w')).toBe('50');
      // KS-3018: бинарная плашка заменена на PrecisionScoreBlock. 1 user-
      // полуход → score=null (null-state).
      const scoreBlock = screen.getByTestId('precision-score-block');
      // KS-3033 (shared MIN_HALF_MOVES_FOR_SCORE=1): 1-полуход теперь
    // получает реальный score; tone не unavailable.
    expect(scoreBlock.getAttribute('data-tone')).not.toBe('unavailable');
    });

    it('KS-2968 — drop в пределах порога (92→90): preserved=true', async () => {
      // Контрольный кейс: drop=20 ‰ ≤ 150 ‰ — это не «потеря», UI
      // должен оставить плашку «удержано».
      const puzzle = makePuzzle({
        playVsEngine: {
          blunderMove: 'd2d4',
          wdlAfterBlunder: 0.92,
          winThreshold: 0.5,
          failThreshold: 0,
          halfMovesN: 2,
          wdlAfter: { w: 920, d: 80, l: 0 },
        },
      });
      const engine = new ScriptedEngine([
        result(
          line({ type: 'cp', value: 200 }, ['e2e4'], 12, 1, {
            w: 920,
            d: 80,
            l: 0,
          }),
        ),
        result(
          line({ type: 'cp', value: 200 }, ['e2e4'], 12, 1, {
            w: 920,
            d: 80,
            l: 0,
          }),
        ),
        // POV opp {0, 100, 900} → flipWdl POV user {900, 100, 0}.
        result(
          line({ type: 'cp', value: -300 }, ['e7e5'], 12, 1, {
            w: 0,
            d: 100,
            l: 900,
          }),
        ),
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
      expect(summary.getAttribute('data-start-w')).toBe('92');
      expect(summary.getAttribute('data-final-w')).toBe('90');
    });

    it('fallback на серверный wdlAfter, если initial analyze не вернул wdl', async () => {
      // Старые movки/сборки SF без UCI_ShowWDL → initial возвращает
      // info без `wdl` поля. Раннер должен остаться на серверном
      // baseline (back-compat).
      const puzzle = makePuzzle({
        playVsEngine: {
          blunderMove: 'd2d4',
          wdlAfterBlunder: 0.6,
          winThreshold: 0.5,
          failThreshold: 0.1,
          halfMovesN: 6,
          wdlAfter: { w: 850, d: 130, l: 20 },
        },
      });
      const engine = new ScriptedEngine([
        // initial без wdl → clientBaselineWdl остаётся null.
        result(line({ type: 'cp', value: 0 }, ['e2e4'])),
        result(line({ type: 'cp', value: 50 }, ['d2d4'])),
        result(
          line({ type: 'cp', value: 800 }, ['d7d5'], 12, 1, {
            w: 780,
            d: 200,
            l: 20,
          }),
        ),
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
        const sum = screen.getByTestId('puzzle-engine-wdl-summary');
        if (sum.getAttribute('data-mode') !== 'permille') {
          throw new Error('still on signed fallback');
        }
      });
      const summary = screen.getByTestId('puzzle-engine-wdl-summary');
      // start берётся из серверного wdlAfter (850/130/20 → 85/13/2).
      expect(summary.getAttribute('data-start-w')).toBe('85');
      expect(summary.getAttribute('data-start-d')).toBe('13');
      expect(summary.getAttribute('data-start-l')).toBe('2');
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

/**
 * KS-3166 (universal hint без objective-branching) + KS-3369 (плашка
 * убрана). После KS-3369 текстовой плашки нет — её роль закрывает
 * replay-кнопка (KS-3366). Тесты сохраняют `data-puzzle-phase` контракт
 * на replay-кнопке, чтобы интеграционные сценарии (отображение фазы
 * пазла) продолжали работать без отдельного hint-узла.
 */
describe('PlayVsEngineRunner KS-3369 — replay-кнопка несёт data-puzzle-phase', () => {
  const phaseCases = [
    {
      label: 'reactive + convertAdvantage',
      themes: ['playVsEngine', 'convertAdvantage', 'reactive'],
      expected: 'reactive',
    },
    {
      label: 'reactive + saveEquality',
      themes: ['playVsEngine', 'saveEquality', 'reactive'],
      expected: 'reactive',
    },
    {
      label: 'preventive',
      themes: ['playVsEngine', 'convertAdvantage', 'preventive'],
      expected: 'preventive',
    },
    {
      label: 'legacy без phase-тега',
      themes: ['playVsEngine', 'mateIn2'],
      expected: '',
    },
  ] as const;

  for (const { label, themes, expected } of phaseCases) {
    it(`${label} → replay-кнопка с data-puzzle-phase="${expected}"`, async () => {
      const puzzle = makePuzzle({
        themes: [...themes],
        playVsEngine: {
          blunderMove: 'd2d4',
          fenBeforeBlunder:
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          wdlAfterBlunder: 0.6,
          winThreshold: 0.5,
          failThreshold: 0.0,
          halfMovesN: 4,
          objective: 'convertAdvantage',
        },
      });
      const engine = new ScriptedEngine([INITIAL_ANALYZE()]);
      renderWithProviders(
        <PlayVsEngineRunner puzzle={puzzle} onSubmit={vi.fn()} engineFactory={() => engine} />,
      );
      const btn = await screen.findByTestId('puzzle-engine-replay-blunder');
      expect(btn.getAttribute('data-puzzle-phase')).toBe(expected);
      // KS-3369: текстовой плашки в DOM нет.
      expect(
        screen.queryByTestId('puzzle-engine-blunder-hint'),
      ).not.toBeInTheDocument();
    });
  }
});

/**
 * KS-3164 (ADR-070 UI): формат номера хода в hint зависит от
 * `puzzlePhase`. Для preventive solver = сам зевнувший, и формат
 * совпадает с реальным ходом партии:
 *  - белый зевок (side-to-move='w' на fenBefore) → «N. san»;
 *  - чёрный зевок (side-to-move='b' на fenBefore) → «N... san».
 * Реактивная формула (через противника) даёт обратное и до KS-3164
 * показывала «38... d6» на превентивном пазле KS-3139, где должно
 * быть «39. d6».
 */
describe('formatBlunderMoveWithNumber KS-3164 — preventive phase', () => {
  it('preventive + white blunder (sideToMove=w) → «N. san»', () => {
    // fenBefore KS-3139, ход 39. d6: side='w', fullmove=39.
    const fenBefore =
      '8/1k4bP/8/1P1P2p1/5p2/3K4/1P3P2/8 w - - 1 39';
    expect(
      formatBlunderMoveWithNumber('d6', fenBefore, 'preventive'),
    ).toBe('39. d6');
  });

  it('preventive + black blunder (sideToMove=b) → «N... san»', () => {
    // Условная позиция: ход 22... Bxc3 (чёрные).
    const fenBefore =
      'rnbqkbnr/pppppppp/8/8/8/2N5/PPPPPPPP/R1BQKBNR b KQkq - 0 22';
    expect(
      formatBlunderMoveWithNumber('Bxc3', fenBefore, 'preventive'),
    ).toBe('22... Bxc3');
  });

  it('reactive (или без phase) — старая логика через противника', () => {
    // fenAfter после хода белых 3. d4: side='b', fullmove=3 → «3. d4».
    const fenAfterWhiteBlunder =
      'rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 3';
    expect(
      formatBlunderMoveWithNumber('d4', fenAfterWhiteBlunder, 'reactive'),
    ).toBe('3. d4');
    expect(
      formatBlunderMoveWithNumber('d4', fenAfterWhiteBlunder),
    ).toBe('3. d4');

    // fenAfter после хода чёрных 22... f6: side='w', fullmove=23 → «22... f6».
    const fenAfterBlackBlunder =
      'rnbqkbnr/ppppp1pp/5p2/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 23';
    expect(
      formatBlunderMoveWithNumber('f6', fenAfterBlackBlunder, 'reactive'),
    ).toBe('22... f6');
  });

  it('пустой SAN → пустая строка (caller выбирает generic)', () => {
    expect(formatBlunderMoveWithNumber('', '8/8 w - - 0 1', 'preventive')).toBe(
      '',
    );
    expect(formatBlunderMoveWithNumber('', '8/8 b - - 0 1', 'reactive')).toBe(
      '',
    );
  });
});

// KS-3365 / KS-3369: анимация blunderMove на старте + плашка hint
// удалена. Тестируем через replay-кнопку, которая выступает «маркером»
// что blunder известен (data-blunder-known=true).
describe('PlayVsEngineRunner KS-3365 — анимация blunderMove на старте', () => {
  it('blunder known → replay-кнопка с data-blunder-known=true; в DOM нет hint', async () => {
    const puzzle = makePuzzle({
      fen: '8/1k4bP/8/1P1P2p1/5p2/3K4/1P3P2/8 w - - 1 39',
      themes: ['playVsEngine', 'convertAdvantage', 'preventive'],
      playVsEngine: {
        blunderMove: 'd5d6',
        fenBeforeBlunder: '8/1k4bP/8/1P1P2p1/5p2/3K4/1P3P2/8 w - - 1 39',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 4,
        objective: 'convertAdvantage',
      },
    } as Partial<PuzzleDto>);
    const engine = new ScriptedEngine([INITIAL_ANALYZE()]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} onSubmit={vi.fn()} engineFactory={() => engine} />,
    );
    const btn = await screen.findByTestId('puzzle-engine-replay-blunder');
    expect(btn.getAttribute('data-blunder-known')).toBe('true');
    // KS-3369: плашка с текстом удалена.
    expect(
      screen.queryByTestId('puzzle-engine-blunder-hint'),
    ).not.toBeInTheDocument();
    // SAN-нотации хода нет нигде в DOM (KS-3355 — без SAN).
    expect(document.body.textContent ?? '').not.toMatch(/39\. d6/);
    expect(document.body.textContent ?? '').not.toMatch(/d5d6/);
  });

  it('legacy без fenBeforeBlunder → ни replay-кнопки, ни hint', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: '',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 4,
      },
    } as Partial<PuzzleDto>);
    const engine = new ScriptedEngine([INITIAL_ANALYZE()]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} onSubmit={vi.fn()} engineFactory={() => engine} />,
    );
    expect(
      screen.queryByTestId('puzzle-engine-replay-blunder'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('puzzle-engine-blunder-hint'),
    ).not.toBeInTheDocument();
  });

  it('blunderMove известен → replay-кнопка с data-blunder-known=true', async () => {
    const fenBefore =
      'rnbqkbnr/pppppppp/8/8/8/2N5/PPPPPPPP/R1BQKBNR b KQkq - 0 22';
    const puzzle = makePuzzle({
      fen: 'rnbqkbnr/pppppppp/8/8/8/2b5/PPPPPPPP/R1BQKBNR w KQkq - 0 23',
      playVsEngine: {
        blunderMove: 'f8c3',
        fenBeforeBlunder: fenBefore,
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 4,
      },
    } as Partial<PuzzleDto>);
    const engine = new ScriptedEngine([INITIAL_ANALYZE()]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} onSubmit={vi.fn()} engineFactory={() => engine} />,
    );
    const btn = await screen.findByTestId('puzzle-engine-replay-blunder');
    expect(btn.getAttribute('data-blunder-known')).toBe('true');
  });
});

describe('PlayVsEngineRunner KS-3366 — кнопка «Проиграть последний ход»', () => {
  it('blunderMove + fenBeforeBlunder есть → кнопка рендерится', async () => {
    const fenBefore =
      'rnbqkbnr/pppppppp/8/8/8/2N5/PPPPPPPP/R1BQKBNR b KQkq - 0 22';
    const puzzle = makePuzzle({
      fen: 'rnbqkbnr/pppppppp/8/8/8/2b5/PPPPPPPP/R1BQKBNR w KQkq - 0 23',
      playVsEngine: {
        blunderMove: 'f8c3',
        fenBeforeBlunder: fenBefore,
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 4,
      },
    } as Partial<PuzzleDto>);
    const engine = new ScriptedEngine([INITIAL_ANALYZE()]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} onSubmit={vi.fn()} engineFactory={() => engine} />,
    );
    const btn = await screen.findByTestId('puzzle-engine-replay-blunder');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/Replay last move|Проиграть/);
  });

  it('legacy без blunderMove → кнопка НЕ рендерится', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: '',
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 4,
      },
    } as Partial<PuzzleDto>);
    const engine = new ScriptedEngine([INITIAL_ANALYZE()]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} onSubmit={vi.fn()} engineFactory={() => engine} />,
    );
    // KS-3369: progress-блок гарантированно отрендерен на старте —
    // используем его как маркер «runner смонтирован».
    await screen.findByTestId('puzzle-engine-progress');
    expect(
      screen.queryByTestId('puzzle-engine-replay-blunder'),
    ).toBeNull();
  });

  it('клик по кнопке не падает (replay вызывается)', async () => {
    const fenBefore =
      'rnbqkbnr/pppppppp/8/8/8/2N5/PPPPPPPP/R1BQKBNR b KQkq - 0 22';
    const puzzle = makePuzzle({
      fen: 'rnbqkbnr/pppppppp/8/8/8/2b5/PPPPPPPP/R1BQKBNR w KQkq - 0 23',
      playVsEngine: {
        blunderMove: 'f8c3',
        fenBeforeBlunder: fenBefore,
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 4,
      },
    } as Partial<PuzzleDto>);
    const engine = new ScriptedEngine([INITIAL_ANALYZE()]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} onSubmit={vi.fn()} engineFactory={() => engine} />,
    );
    const btn = await screen.findByTestId('puzzle-engine-replay-blunder');
    btn.click();
    // KS-3369: кнопка остаётся в DOM после клика (replay не убирает её).
    expect(
      screen.getByTestId('puzzle-engine-replay-blunder'),
    ).toBeInTheDocument();
  });

  // KS-3370: для preventive-пазлов (fenBeforeBlunder == puzzle.fen)
  // replay-анимация показывает blunderMove и потом откатывает обратно
  // на стартовую позицию. Кнопка работает (не падает на повторных кликах).
  it('KS-3370: preventive — клик по replay не падает (revert-таймер планируется)', async () => {
    // Превентивный пазл: solver играет ВМЕСТО блaндера, fenBefore == puzzle.fen.
    const startFen = '8/1k4bP/8/1P1P2p1/5p2/3K4/1P3P2/8 w - - 1 39';
    const puzzle = makePuzzle({
      fen: startFen,
      themes: ['playVsEngine', 'convertAdvantage', 'preventive'],
      playVsEngine: {
        blunderMove: 'd5d6',
        fenBeforeBlunder: startFen, // KS-3370: для preventive они равны
        wdlAfterBlunder: 0.6,
        winThreshold: 0.5,
        failThreshold: 0.0,
        halfMovesN: 4,
        objective: 'convertAdvantage',
      },
    } as Partial<PuzzleDto>);
    const engine = new ScriptedEngine([INITIAL_ANALYZE()]);
    renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} onSubmit={vi.fn()} engineFactory={() => engine} />,
    );
    const btn = await screen.findByTestId('puzzle-engine-replay-blunder');
    expect(btn.getAttribute('data-puzzle-phase')).toBe('preventive');
    // Повторные клики не должны бросать (cancelBlunderTimers внутри).
    btn.click();
    btn.click();
    btn.click();
    expect(
      screen.getByTestId('puzzle-engine-replay-blunder'),
    ).toBeInTheDocument();
  });
});

describe('PlayVsEngineRunner KS-3349 — Back/Next + rating delta', () => {
  /**
   * Хелпер: гоним runner до state=win через тот же mate-сценарий, что и
   * win-engine-resign. Возвращает container для последующих ассертов.
   */
  async function runToWin(props: Partial<{
    onBack: () => void;
    onNext: () => void;
    precisionRatingChange:
      | { ratingBefore: number; ratingAfter: number; ratingDelta: number }
      | null;
  }> = {}) {
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
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 50 }, ['e2e4'])),
      result(line({ type: 'mate', value: -2 }, ['e7e5'])),
    ]);
    const { container } = renderWithProviders(
      <PlayVsEngineRunner
        puzzle={puzzle}
        onSubmit={vi.fn()}
        engineFactory={() => engine}
        {...props}
      />,
    );
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => {
      expect(
        container
          .querySelector('[data-testid="puzzle-engine-runner"]')
          ?.getAttribute('data-state'),
      ).toBe('win');
    });
    return container;
  }

  it('без onBack/onNext: блок «Назад/Следующая» не рендерится', async () => {
    const container = await runToWin();
    expect(
      container.querySelector('[data-testid="precision-result-actions"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="puzzle-engine-back"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="puzzle-engine-next"]'),
    ).toBeNull();
  });

  it('onBack + onNext: рендерит обе кнопки рядом в одной строке', async () => {
    const onBack = vi.fn();
    const onNext = vi.fn();
    const container = await runToWin({ onBack, onNext });
    const actions = container.querySelector(
      '[data-testid="precision-result-actions"]',
    );
    expect(actions).not.toBeNull();
    const back = container.querySelector(
      '[data-testid="puzzle-engine-back"]',
    ) as HTMLButtonElement | null;
    const next = container.querySelector(
      '[data-testid="puzzle-engine-next"]',
    ) as HTMLButtonElement | null;
    expect(back).not.toBeNull();
    expect(next).not.toBeNull();
    back!.click();
    expect(onBack).toHaveBeenCalledTimes(1);
    next!.click();
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('precisionRatingChange: рендерит дельту «1487 → 1502 (+15)»', async () => {
    const container = await runToWin({
      precisionRatingChange: {
        ratingBefore: 1487,
        ratingAfter: 1502,
        ratingDelta: 15,
      },
    });
    const block = container.querySelector(
      '[data-testid="precision-rating-change"]',
    );
    expect(block).not.toBeNull();
    expect(block!.getAttribute('data-rating-delta')).toBe('15');
    expect(
      container.querySelector(
        '[data-testid="precision-rating-change-text"]',
      )?.textContent,
    ).toContain('1487 → 1502 (+15)');
    expect(block!.className).toContain('precision-rating-change--gain');
  });

  it('отрицательная дельта → класс --loss и знак «-»', async () => {
    const container = await runToWin({
      precisionRatingChange: {
        ratingBefore: 1500,
        ratingAfter: 1488,
        ratingDelta: -12,
      },
    });
    const block = container.querySelector(
      '[data-testid="precision-rating-change"]',
    );
    expect(block!.className).toContain('precision-rating-change--loss');
    expect(
      container.querySelector(
        '[data-testid="precision-rating-change-text"]',
      )?.textContent,
    ).toContain('1500 → 1488 (-12)');
  });

  it('precisionRatingChange=null (гость) → блок дельты НЕ рендерится', async () => {
    const container = await runToWin({
      precisionRatingChange: null,
      onBack: vi.fn(),
      onNext: vi.fn(),
    });
    expect(
      container.querySelector('[data-testid="precision-rating-change"]'),
    ).toBeNull();
    // Кнопки при этом всё равно отображаются.
    expect(
      container.querySelector('[data-testid="puzzle-engine-back"]'),
    ).not.toBeNull();
  });
});

describe('PlayVsEngineRunner KS-3393 — классификация из глубоких live-оценок', () => {
  // KS-3393: cpBefore/wdlBefore — из глубокого live-снимка позиции ДО
  // хода (или fallback pre-analyze, если live не успел — как в моках,
  // где analyzeLive no-op). cpAfter/wdlAfter:
  //   - playedUci === bestUci → копия cpBefore/wdlBefore (lossE=0).
  //   - playedUci !== bestUci → ГЛУБОКИЙ post-analyze позиции ПОСЛЕ хода,
  //     POV решателя (flip wdl / negate cp). extra-analyze searchmoves
  //     (KS-3380) удалён.
  it('KS-3393: playedUci === bestUci → snapshot.wdlAfter=wdlBefore, cpAfter=cpBefore', async () => {
    // halfMovesN=1: user сразу финиширует, submit вызывается сразу.
    const puzzle = makePuzzle({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 2, // никогда не победа — заставляем lose
        failThreshold: 0.5,
        halfMovesN: 1,
      },
    });
    const onSubmit = vi.fn();
    // pre PV1='e2e4' (тот же что played) → isBest=true → snapshot
    // получит cpAfter=cpBefore=+50, wdlAfter=wdlBefore={w:380,d:620,l:0}.
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(
        line({ type: 'cp', value: 50 }, ['e2e4'], 18, 1, {
          w: 380,
          d: 620,
          l: 0,
        }),
      ),
      // post-analyze: cp +800 POV opp → wdlUser=-0.92 → lose (но
      // snapshot уже имеет best-case данные из pre, post НЕ
      // перезаписывает их в новой логике).
      result(line({ type: 'cp', value: 800 }, ['e7e5'])),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner
        puzzle={puzzle}
        onSubmit={onSubmit}
        engineFactory={() => engine}
      />,
    );
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.moves).toHaveLength(1);
    // KS-3380: best-case → cpAfter=cpBefore (не из post-analyze!).
    expect(arg.moves[0].playedUci).toBe('e2e4');
    expect(arg.moves[0].bestUci).toBe('e2e4');
    expect(arg.moves[0].cpBefore).toBe(50);
    expect(arg.moves[0].cpAfter).toBe(50); // КРИТИЧЕСКИЙ: pre-frame
    expect(arg.moves[0].wdlBefore).toEqual({ w: 380, d: 620, l: 0 });
    expect(arg.moves[0].wdlAfter).toEqual({ w: 380, d: 620, l: 0 });
  });

  it('KS-3393: не-best → cpAfter/wdlAfter из глубокого post-analyze (POV решателя, flip/negate)', async () => {
    // halfMovesN=2 → user-ход + runEngineCycle (глубокий post-analyze).
    // Live в моке no-op → fallback pre-analyze: PV1=d2d4 ≠ played e2e4
    // → !isBest. wdlAfter/cpAfter берутся из ГЛУБОКОГО post-analyze
    // позиции после e2e4 (ходит соперник → POV решателя через flip/negate).
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 2,
        failThreshold: 0.5,
        halfMovesN: 2,
      },
    });
    const onSubmit = vi.fn();
    const engine = new ScriptedEngine([
      INITIAL_ANALYZE(),
      result(line({ type: 'cp', value: 50 }, ['d2d4'])), // fallback pre best=d2d4
      // post-analyze позиции после e2e4 (ход соперника). cp +800 POV
      // соперника → cpAfter=-800; wdl {600,350,50} POV соперника →
      // flip → wdlAfter {50,350,600} POV решателя.
      result(
        line({ type: 'cp', value: 800 }, ['d7d5'], 24, 1, {
          w: 600,
          d: 350,
          l: 50,
        }),
      ),
    ]);
    renderWithProviders(
      <PlayVsEngineRunner
        puzzle={puzzle}
        onSubmit={onSubmit}
        engineFactory={() => engine}
      />,
    );
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.moves[0].bestUci).toBe('d2d4');
    expect(arg.moves[0].playedUci).toBe('e2e4');
    // KS-3393: из глубокого post-analyze позиции после хода, POV решателя.
    expect(arg.moves[0].cpAfter).toBe(-800);
    expect(arg.moves[0].wdlAfter).toEqual({ w: 50, d: 350, l: 600 });
  });

  it('KS-3393: wdlBefore/cpBefore/bestUci берутся из ГЛУБОКОГО live-снимка', async () => {
    // Движок стримит глубокий live-снимок позиции игрока через
    // analyzeLive — классификация должна взять wdlBefore ОТТУДА (а не из
    // fallback pre-analyze). После хода — глубокий post для wdlAfter.
    class ClassifyLiveEngine implements EngineAdapter {
      private q: AnalysisResult[];
      private liveInfo: InfoLine;
      constructor(q: AnalysisResult[], liveInfo: InfoLine) {
        this.q = [...q];
        this.liveInfo = liveInfo;
      }
      async init(): Promise<void> {}
      setOption(): void {}
      async analyze(): Promise<AnalysisResult> {
        return (
          this.q.shift() ?? {
            lines: [],
            bestByDepth: new Map(),
            evalByDepth: new Map(),
            firstAppearance: 0,
          }
        );
      }
      async analyzeLive(
        _fen: string,
        _mp: number,
        onUpdate: (info: InfoLine) => void,
      ): Promise<void> {
        onUpdate(this.liveInfo);
      }
      stop(): void {}
      destroy(): void {}
    }

    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.6,
        winThreshold: 2,
        failThreshold: 0.5,
        halfMovesN: 2,
      },
    });
    const onSubmit = vi.fn();
    // analyze-очередь: [0]=baseline (initial effect), [1]=глубокий post.
    // liveInfo — глубокий снимок позиции игрока (puzzle.fen, белые):
    // bestUci=d2d4, cp=+120, wdl={560,400,40} POV решателя.
    const engine = new ClassifyLiveEngine(
      [
        result(line({ type: 'cp', value: 0 }, ['e2e4'], 14, 1, { w: 400, d: 500, l: 100 })),
        // post после e2e4 (ход соперника): cp +500 POV соперника →
        // cpAfter=-500; wdl {300,450,250} → flip → {250,450,300}.
        result(line({ type: 'cp', value: 500 }, ['d7d5'], 24, 1, { w: 300, d: 450, l: 250 })),
      ],
      line({ type: 'cp', value: 120 }, ['d2d4'], 26, 1, { w: 560, d: 400, l: 40 }),
    );
    const { container } = renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} onSubmit={onSubmit} engineFactory={() => engine} />,
    );
    // Ждём, пока live-снимок прокинется в полосу (data-latest-wdl).
    await waitFor(() => {
      expect(
        container
          .querySelector('[data-testid="puzzle-engine-runner"]')
          ?.getAttribute('data-latest-wdl'),
      ).toBe('560,400,40');
    });
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const arg = onSubmit.mock.calls[0][0];
    // wdlBefore/cpBefore/bestUci — из глубокого live-снимка.
    expect(arg.moves[0].bestUci).toBe('d2d4');
    expect(arg.moves[0].cpBefore).toBe(120);
    expect(arg.moves[0].wdlBefore).toEqual({ w: 560, d: 400, l: 40 });
    // wdlAfter — из глубокого post, POV решателя (flip/negate).
    expect(arg.moves[0].cpAfter).toBe(-500);
    expect(arg.moves[0].wdlAfter).toEqual({ w: 250, d: 450, l: 300 });
  });
});

describe('PlayVsEngineRunner KS-3394 — baseline из глубокого live стартовой позиции', () => {
  // Движок: initial analyze (мелкий) даёт baseline 76%, а live стримит
  // ГЛУБОКИЙ 99% для стартовой позиции. После KS-3394 «start» в summary
  // должен быть 99% (глубокий live), а не 76% (мелкий initial).
  class BaselineLiveEngine implements EngineAdapter {
    private q: AnalysisResult[];
    private liveInfo: InfoLine;
    constructor(q: AnalysisResult[], liveInfo: InfoLine) {
      this.q = [...q];
      this.liveInfo = liveInfo;
    }
    async init(): Promise<void> {}
    setOption(): void {}
    async analyze(): Promise<AnalysisResult> {
      return (
        this.q.shift() ?? {
          lines: [],
          bestByDepth: new Map(),
          evalByDepth: new Map(),
          firstAppearance: 0,
        }
      );
    }
    async analyzeLive(
      _fen: string,
      _mp: number,
      onUpdate: (info: InfoLine) => void,
    ): Promise<void> {
      onUpdate(this.liveInfo);
    }
    stop(): void {}
    destroy(): void {}
  }

  it('summary «start» = глубокий live baseline (99%), не мелкий initial (76%)', async () => {
    const puzzle = makePuzzle({
      playVsEngine: {
        blunderMove: 'd2d4',
        wdlAfterBlunder: 0.9,
        winThreshold: 0.5,
        failThreshold: -2, // не уходим в lose досрочно
        halfMovesN: 2,
      },
    });
    const onSubmit = vi.fn();
    // [0] initial МЕЛКИЙ baseline 76% ({760,200,40}); [1] post после d2d4
    // (ход соперника): wdl {10,80,910} POV соперника → flip → {910,80,10}
    // POV решателя (final в summary).
    const engine = new BaselineLiveEngine(
      [
        result(line({ type: 'cp', value: 200 }, ['d2d4'], 14, 1, { w: 760, d: 200, l: 40 })),
        result(line({ type: 'cp', value: -700 }, ['d7d5'], 24, 1, { w: 10, d: 80, l: 910 })),
      ],
      // live ГЛУБОКИЙ снимок стартовой позиции: 99% ({990,8,2}), best=d2d4.
      line({ type: 'cp', value: 900 }, ['d2d4'], 30, 1, { w: 990, d: 8, l: 2 }),
    );
    const { container } = renderWithProviders(
      <PlayVsEngineRunner puzzle={puzzle} onSubmit={onSubmit} engineFactory={() => engine} />,
    );
    // Ждём глубокий live baseline в полосе.
    await waitFor(() => {
      expect(
        container
          .querySelector('[data-testid="puzzle-engine-runner"]')
          ?.getAttribute('data-latest-wdl'),
      ).toBe('990,8,2');
    });
    // Играем лучший ход d2d4 → партия завершится (userMovesTarget=1).
    (screen.getByTestId('fire-square-d2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-d4') as HTMLButtonElement).click();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());

    // KS-3394: «start» в summary = permilleToPercent(990) = 99, НЕ 76.
    const summary = container.querySelector(
      '[data-testid="puzzle-engine-wdl-summary"]',
    );
    expect(summary).not.toBeNull();
    expect(summary?.getAttribute('data-start-w')).toBe('99');
  });
});

/**
 * KS-3391 — «живой» поток WDL в полосу шансов. Проверяем интеграцию:
 * раннер запускает `analyzeLive` на стартовой позиции и прокидывает
 * промежуточные оценки (onUpdate) в `latestWdl` (атрибут `data-latest-wdl`).
 * POV — решателя: на позиции игрока side-to-move == решатель, флипа нет.
 */
describe('PlayVsEngineRunner KS-3391 live WDL stream', () => {
  /**
   * Стриминговый движок: `analyze` отдаёт baseline (для initial-эффекта),
   * `analyzeLive` эмитит одну промежуточную оценку с ОТЛИЧНЫМ от baseline
   * WDL — так мы доказываем, что полоса обновилась именно из live-потока.
   */
  class LiveStreamEngine implements EngineAdapter {
    constructor(
      private baseline: AnalysisResult,
      private liveInfo: InfoLine,
    ) {}
    async init(): Promise<void> {}
    setOption(): void {}
    async analyze(): Promise<AnalysisResult> {
      return this.baseline;
    }
    async analyzeLive(
      _fen: string,
      _multiPv: number,
      onUpdate: (info: InfoLine) => void,
    ): Promise<void> {
      onUpdate(this.liveInfo);
      // Резолвимся сразу (в проде — на bestmove после stop). Для теста
      // достаточно эмитнуть одно уточнение и не держать очередь.
    }
    stop(): void {}
    destroy(): void {}
  }

  it('раннер прокидывает live onUpdate в data-latest-wdl (POV решателя)', async () => {
    const puzzle = makePuzzle();
    // baseline WDL — одно, live — другое; ждём, что победит live.
    const baseline = result(
      line({ type: 'cp', value: 20 }, ['e2e4'], 14, 1, { w: 500, d: 400, l: 100 }),
    );
    const liveInfo = line({ type: 'cp', value: 80 }, ['e2e4'], 26, 1, {
      w: 720,
      d: 200,
      l: 80,
    });
    const engine = new LiveStreamEngine(baseline, liveInfo);

    const { container } = renderWithProviders(
      <PlayVsEngineRunner
        puzzle={puzzle}
        onSubmit={vi.fn()}
        engineFactory={() => engine}
      />,
    );

    await waitFor(() => {
      expect(
        container
          .querySelector('[data-testid="puzzle-engine-runner"]')
          ?.getAttribute('data-latest-wdl'),
      ).toBe('720,200,80');
    });
  });
});
