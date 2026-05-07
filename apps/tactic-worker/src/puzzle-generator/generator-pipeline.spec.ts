/**
 * KS-2464 / ADR-044 §6. Тесты pipeline'а play-vs-engine с моком engine.
 *
 * Проверяем:
 *   - blunder-фильтр (X) срабатывает на blunderΔ.
 *   - samePv1 — ход партии = PV1 движка → drop.
 *   - skipDecided — |WDL| > 0.95 → drop.
 *   - solvability check pass/fail на разных WDL-траекториях.
 *   - Запись puzzle: solutionMode='play-vs-engine', moves='',
 *     sourceMetadata содержит blunderMove/wdlAfterBlunder и т.д.
 *   - Инвариант accountedFor=analyzed.
 */
import { Chess } from 'chess.js';
import {
  pickPgnHeaders,
  runPuzzleGenerator,
  samePv1,
} from './generator-pipeline';
import {
  defaultGeneratorOptions,
  type EngineApi,
  type MultiPvLine,
  type PuzzleRecord,
} from './types';

function firstLegalUci(fen: string): string {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return 'a1a1';
  const m = moves[0];
  return `${m.from}${m.to}${m.promotion ?? ''}`;
}

function pvWdl(
  bestUci: string,
  wdlSigned: number,
  cp: number = 0,
): MultiPvLine {
  // Преобразуем WDL_signed [-1..1] в (W,D,L) per-mille.
  // Простая модель: при wdl >= 0 → W = (1+wdl)/2 * 1000, L = (1-wdl)/2 * 1000.
  const w = Math.round(((1 + wdlSigned) / 2) * 1000);
  const l = 1000 - w;
  return {
    pv: bestUci,
    score: { type: 'cp', value: cp },
    bestMove: bestUci,
    wdl: { w, d: 0, l },
  };
}

const buildPgn = (): string => {
  const c = new Chess();
  const moves = [
    'e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'd3', 'd6',
    'O-O', 'Nf6', 'h3', 'h6', 'Nc3', 'Bg4', 'Be3', 'Bxe3',
    'fxe3', 'Qd7', 'a3', 'Bxh3', 'gxh3', 'Qxh3',
  ];
  for (const m of moves) c.move(m);
  return c.pgn();
};

function makePgRowMock(pgn: string, opts: Partial<{ ply_count: number; white_elo: number; black_elo: number }> = {}) {
  return {
    query: jest
      .fn<Promise<{ rows: unknown[] }>, [string, unknown[]]>()
      .mockResolvedValueOnce({
        rows: [
          {
            id: '00000000-0000-0000-0000-000000000001',
            pgn,
            white_elo: opts.white_elo ?? 1800,
            black_elo: opts.black_elo ?? 1800,
            ply_count: opts.ply_count ?? 22,
            time_control_category: 'classical',
          },
        ],
      })
      .mockResolvedValue({ rows: [] }),
  };
}

describe('runPuzzleGenerator (play-vs-engine, KS-2464 / KS-2470)', () => {
  it('детектит зевок и пишет puzzle с solutionMode="play-vs-engine"', async () => {
    const pgn = buildPgn();
    // KS-2470: parallel-friendly mock. В `buildPgn` на startPly=20 ходит
    // чёрный (Bxh3), значит blunderTurn='b', solverSide='w'.
    // Стратегия: на pre-analyze (multiPV=2) если sideToMove ≠ solver —
    // ходит блундёр, PV1=alt, wdl≈0 (samePv1 не сработает, не decided).
    // На post-analyze: ходит solver, PV1=first, wdl=+0.8 (зевок).
    // Solvability (multiPV=1): +0.8 для решающей, -0.8 для противника.
    const solverSide: 'w' | 'b' = 'w';

    const engine: EngineApi = {
      analyzePositionWdl: jest.fn(
        async (fen: string, _l, multiPV: number): Promise<MultiPvLine[]> => {
          const first = firstLegalUci(fen);
          const alt = first === 'a1a1' ? 'b1b1' : 'a1a1';
          const sideToMove = fen.split(' ')[1] as 'w' | 'b';
          if (multiPV === 2) {
            // Pre-analyze: ходит блундёр (sideToMove != solver) → PV1=alt,
            // wdl≈0 (не decided, samePv1 не срабатывает).
            // Post-analyze: ходит solver (sideToMove == solver) → PV1=first,
            // wdl=+0.8 (зевок зафиксирован).
            if (sideToMove === solverSide) {
              return [pvWdl(first, 0.8), pvWdl(alt, 0.7)];
            }
            return [pvWdl(alt, 0.0), pvWdl(first, -0.05)];
          }
          // Solvability (multiPV=1): +0.8 для решающей, -0.8 для противника.
          const wdl = sideToMove === solverSide ? 0.8 : -0.8;
          return [pvWdl(first, wdl)];
        },
      ),
    };

    const inserted: PuzzleRecord[] = [];
    const insertPuzzle = jest.fn(async (p: PuzzleRecord) => {
      inserted.push(p);
      return true;
    });
    const fakePg = makePgRowMock(pgn);
    const opts = defaultGeneratorOptions({
      maxGames: 1,
      blunderDelta: 0.5,
      halfMovesN: 2,
      winThreshold: 0.5,
      failThreshold: 0.0,
      minWdlAfterBlunder: 0.5,
      startPly: 20,
      engineLimit: { timeMs: 100 },
    });
    const stats = await runPuzzleGenerator({
      pg: fakePg as never,
      engine,
      options: { ...opts, insertPuzzle },
    });
    expect(stats.gamesProcessed).toBe(1);
    expect(stats.positionsAnalyzed).toBeGreaterThan(0);
    expect(stats.inserted).toBeGreaterThanOrEqual(1);
    const p = inserted[0];
    expect(p.solutionMode).toBe('play-vs-engine');
    expect(p.moves).toBe('');
    expect(p.acceptedMoves).toBeNull();
    const meta = JSON.parse(p.sourceMetadata);
    expect(meta.blunderMove).toMatch(/^[a-h][1-8][a-h][1-8]/);
    expect(meta.wdlAfterBlunder).toBeGreaterThanOrEqual(0.5);
    expect(meta.halfMovesN).toBe(2);
    expect(p.themes.split(' ')).toContain('playVsEngine');
    // accountedFor invariant
    const sumDrops = Object.values(stats.drops).reduce((a, b) => a + b, 0);
    expect(stats.inserted + sumDrops).toBe(stats.positionsAnalyzed);
  });

  it('samePv1 helper: положительные/отрицательные кейсы', () => {
    expect(samePv1('e2e4', 'e2e4')).toBe(true);
    expect(samePv1('e7e8q', 'e7e8q')).toBe(true);
    expect(samePv1('e2e4', 'd2d4')).toBe(false);
    // Promotion vs non-promotion: разный 5-й символ → не совпадение.
    expect(samePv1('e7e8', 'e7e8q')).toBe(false);
    expect(samePv1('e7e8q', 'e7e8r')).toBe(false);
    expect(samePv1('', 'e2e4')).toBe(false);
    expect(samePv1('e2e4', '')).toBe(false);
  });

  it('skipDecided → drop (|wdlBefore| > 0.95)', async () => {
    const pgn = buildPgn();
    const engine: EngineApi = {
      analyzePositionWdl: jest.fn(async (fen: string): Promise<MultiPvLine[]> => {
        // Партия уже выиграна (wdlBefore = +0.99) — ни один ход не зевок.
        const first = firstLegalUci(fen);
        return [pvWdl('b8c6', 0.99), pvWdl(first, 0.95)];
      }),
    };
    const insertPuzzle = jest.fn(async () => true);
    const fakePg = makePgRowMock(pgn);
    const opts = defaultGeneratorOptions({
      maxGames: 1,
      blunderDelta: 0.5,
      skipDecidedWdl: 0.95,
      startPly: 20,
      engineLimit: { timeMs: 50 },
    });
    const stats = await runPuzzleGenerator({
      pg: fakePg as never,
      engine,
      options: { ...opts, insertPuzzle },
    });
    expect(stats.drops.decided).toBeGreaterThan(0);
    expect(stats.inserted).toBe(0);
  });

  it('solvabilityFailed → drop (WDL падает в solvability)', async () => {
    const pgn = buildPgn();
    // Тот же FEN-keyed подход. На startPly=20 ходит чёрный → solverSide='w'.
    const solverSide: 'w' | 'b' = 'w';
    const engine: EngineApi = {
      analyzePositionWdl: jest.fn(
        async (fen: string, _l, multiPV: number): Promise<MultiPvLine[]> => {
          const first = firstLegalUci(fen);
          const alt = first === 'a1a1' ? 'b1b1' : 'a1a1';
          const sideToMove = fen.split(' ')[1] as 'w' | 'b';
          if (multiPV === 2) {
            if (sideToMove === solverSide) {
              return [pvWdl(first, 0.8), pvWdl(alt, 0.7)];
            }
            return [pvWdl(alt, 0.0), pvWdl(first, -0.05)];
          }
          // solvability — обваливается до -1 (фейл).
          return [pvWdl(first, -1.0)];
        },
      ),
    };
    const insertPuzzle = jest.fn(async () => true);
    const fakePg = makePgRowMock(pgn);
    const opts = defaultGeneratorOptions({
      maxGames: 1,
      blunderDelta: 0.5,
      halfMovesN: 2,
      failThreshold: -0.5,
      winThreshold: 0.5,
      minWdlAfterBlunder: 0.5,
      startPly: 20,
      engineLimit: { timeMs: 50 },
    });
    const stats = await runPuzzleGenerator({
      pg: fakePg as never,
      engine,
      options: { ...opts, insertPuzzle },
    });
    expect(stats.drops.solvabilityFailed).toBeGreaterThan(0);
    expect(stats.inserted).toBe(0);
  });

  it('фильтр: bullet → пропуск партии', async () => {
    const pgn = '1. e4 e5 2. Nf3 Nc6 3. Bb5';
    const engine: EngineApi = { analyzePositionWdl: jest.fn() };
    const insertPuzzle = jest.fn(async () => true);
    const fakePg = {
      query: jest
        .fn<Promise<{ rows: unknown[] }>, [string, unknown[]]>()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'g',
              pgn,
              white_elo: 1800,
              black_elo: 1800,
              ply_count: 100,
              time_control_category: 'bullet',
            },
          ],
        })
        .mockResolvedValue({ rows: [] }),
    };
    const opts = defaultGeneratorOptions({ maxGames: 1, startPly: 1 });
    const stats = await runPuzzleGenerator({
      pg: fakePg as never,
      engine,
      options: { ...opts, insertPuzzle },
    });
    expect(stats.gamesProcessed).toBe(1);
    expect(stats.positionsAnalyzed).toBe(0);
    expect(insertPuzzle).not.toHaveBeenCalled();
  });

  it('фильтр: оба Elo < minRating → пропуск', async () => {
    const pgn = '1. e4 e5 2. Nf3 Nc6 3. Bb5';
    const engine: EngineApi = { analyzePositionWdl: jest.fn() };
    const insertPuzzle = jest.fn(async () => true);
    const fakePg = {
      query: jest
        .fn<Promise<{ rows: unknown[] }>, [string, unknown[]]>()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'g',
              pgn,
              white_elo: 1000,
              black_elo: 1000,
              ply_count: 100,
              time_control_category: 'classical',
            },
          ],
        })
        .mockResolvedValue({ rows: [] }),
    };
    const opts = defaultGeneratorOptions({
      maxGames: 1,
      minRating: 1400,
      startPly: 1,
    });
    const stats = await runPuzzleGenerator({
      pg: fakePg as never,
      engine,
      options: { ...opts, insertPuzzle },
    });
    expect(stats.positionsAnalyzed).toBe(0);
    expect(insertPuzzle).not.toHaveBeenCalled();
  });
});

describe('pickPgnHeaders (KS-2489)', () => {
  it('whitelist: возвращает только Seven Tag Roster + ELO', () => {
    const raw = {
      White: 'Carlsen, M.',
      Black: 'Nepomniachtchi, I.',
      Event: 'World Championship 2026',
      Site: 'Dubai UAE',
      Round: '5',
      Date: '2026.04.20',
      Result: '1-0',
      WhiteElo: '2839',
      BlackElo: '2789',
      // Не включаются в whitelist:
      Annotator: 'GM Anand',
      ECO: 'C60',
      TimeControl: '120+30',
    };
    const out = pickPgnHeaders(raw);
    expect(out).toEqual({
      White: 'Carlsen, M.',
      Black: 'Nepomniachtchi, I.',
      Event: 'World Championship 2026',
      Site: 'Dubai UAE',
      Round: '5',
      Date: '2026.04.20',
      Result: '1-0',
      WhiteElo: '2839',
      BlackElo: '2789',
    });
  });

  it('пустые значения и whitespace игнорируются', () => {
    const out = pickPgnHeaders({
      White: '',
      Black: '   ',
      Event: 'Tata Steel',
      Date: undefined,
    });
    expect(out).toEqual({ Event: 'Tata Steel' });
  });

  it('пустой объект → пустой объект', () => {
    expect(pickPgnHeaders({})).toEqual({});
  });

  it('значения тримятся', () => {
    expect(pickPgnHeaders({ White: '  Magnus  ', Date: ' 2026.01.01 ' })).toEqual({
      White: 'Magnus',
      Date: '2026.01.01',
    });
  });
});

describe('runPuzzleGenerator + PGN headers (KS-2489)', () => {
  it('пишет PGN headers в puzzle.sourceMetadata.headers при генерации из archive_game', async () => {
    // PGN с заполненными headers — chess.js getHeaders() их вернёт.
    const c = new Chess();
    c.setHeader('White', 'Carlsen, Magnus');
    c.setHeader('Black', 'Nepomniachtchi, Ian');
    c.setHeader('Event', 'World Championship 2026');
    c.setHeader('Date', '2026.04.20');
    c.setHeader('Result', '1-0');
    c.setHeader('WhiteElo', '2839');
    c.setHeader('BlackElo', '2789');
    const moves = [
      'e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'd3', 'd6',
      'O-O', 'Nf6', 'h3', 'h6', 'Nc3', 'Bg4', 'Be3', 'Bxe3',
      'fxe3', 'Qd7', 'a3', 'Bxh3', 'gxh3', 'Qxh3',
    ];
    for (const m of moves) c.move(m);
    const pgn = c.pgn();

    const solverSide: 'w' | 'b' = 'w';
    const engine: EngineApi = {
      analyzePositionWdl: jest.fn(
        async (fen: string, _l, multiPV: number): Promise<MultiPvLine[]> => {
          const first = firstLegalUci(fen);
          const alt = first === 'a1a1' ? 'b1b1' : 'a1a1';
          const sideToMove = fen.split(' ')[1] as 'w' | 'b';
          if (multiPV === 2) {
            if (sideToMove === solverSide) {
              return [pvWdl(first, 0.8), pvWdl(alt, 0.7)];
            }
            return [pvWdl(alt, 0.0), pvWdl(first, -0.05)];
          }
          const wdl = sideToMove === solverSide ? 0.8 : -0.8;
          return [pvWdl(first, wdl)];
        },
      ),
    };

    const inserted: PuzzleRecord[] = [];
    const insertPuzzle = jest.fn(async (p: PuzzleRecord) => {
      inserted.push(p);
      return true;
    });
    const fakePg = makePgRowMock(pgn);
    const opts = defaultGeneratorOptions({
      maxGames: 1,
      blunderDelta: 0.5,
      halfMovesN: 2,
      winThreshold: 0.5,
      failThreshold: 0.0,
      minWdlAfterBlunder: 0.5,
      startPly: 20,
      engineLimit: { timeMs: 100 },
    });
    await runPuzzleGenerator({
      pg: fakePg as never,
      engine,
      options: { ...opts, insertPuzzle },
    });

    expect(inserted.length).toBeGreaterThanOrEqual(1);
    const meta = JSON.parse(inserted[0].sourceMetadata);
    expect(meta.headers).toBeDefined();
    expect(meta.headers.White).toBe('Carlsen, Magnus');
    expect(meta.headers.Black).toBe('Nepomniachtchi, Ian');
    expect(meta.headers.Event).toBe('World Championship 2026');
    expect(meta.headers.Date).toBe('2026.04.20');
    expect(meta.headers.Result).toBe('1-0');
    expect(meta.headers.WhiteElo).toBe('2839');
    expect(meta.headers.BlackElo).toBe('2789');
    // Старые поля не пострадали.
    expect(meta.blunderMove).toMatch(/^[a-h][1-8][a-h][1-8]/);
    expect(meta.halfMovesN).toBe(2);
  });
});
