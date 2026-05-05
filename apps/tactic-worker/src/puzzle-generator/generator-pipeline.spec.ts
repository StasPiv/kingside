/**
 * Integration-light test: prпрогон pipeline на синтетической партии,
 * где «зевок» сделан намеренно. Engine — заглушка, возвращающая
 * заранее заданные eval'ы и legal-ход через chess.js.
 *
 * Цель — убедиться, что pipeline:
 *   - находит blunder (eval drop ≥ 200cp).
 *   - принимает позицию (spread ≥ 150cp).
 *   - строит линию длиной ≥ minLineLength.
 *   - вызывает insertPuzzle.
 */
import { Chess } from 'chess.js';
import { runPuzzleGenerator } from './generator-pipeline';
import {
  defaultGeneratorOptions,
  type EngineApi,
  type PuzzleRecord,
} from './types';

function firstLegalUci(fen: string): string {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return 'a1a1';
  const m = moves[0];
  return `${m.from}${m.to}${m.promotion ?? ''}`;
}

describe('runPuzzleGenerator — synthetic blunder', () => {
  function buildPgn(): string {
    const c = new Chess();
    const moves = [
      'e4', 'e5',
      'Nf3', 'Nc6',
      'Bc4', 'Bc5',
      'd3', 'd6',
      'O-O', 'Nf6',
      'h3', 'h6',
      'Nc3', 'Bg4',
      'Be3', 'Bxe3',
      'fxe3', 'Qd7',
      'a3', 'Bxh3',
      'gxh3', 'Qxh3',
    ];
    for (const m of moves) c.move(m);
    return c.pgn();
  }

  it('находит зевок и вставляет puzzle', async () => {
    const pgn = buildPgn();

    // Mock engine: на первом analyze(beforeFen) — большой плюс ходящему,
    // на втором analyze(afterFen) — оценки с инверсией → blunder.
    // Дальше — нейтральные оценки. Ходы — первый legal в FEN'е (чтобы
    // applyUci не валился).
    let analyzeCalls = 0;
    const engine: EngineApi = {
      analyze: jest.fn(async (fen: string, _depth: number) => {
        analyzeCalls++;
        if (analyzeCalls === 1) {
          // before move — у ходящего +500
          return {
            bestMove: firstLegalUci(fen),
            score: { type: 'cp', value: 500 } as const,
            depth: 10,
          };
        }
        if (analyzeCalls === 2) {
          // after move — у новой стороны (противника прежней) +400 cp
          // (от её лица), что для прежней = -400 → drop = 900cp.
          return {
            bestMove: firstLegalUci(fen),
            score: { type: 'cp', value: 400 } as const,
            depth: 10,
          };
        }
        return {
          bestMove: firstLegalUci(fen),
          score: { type: 'cp', value: 50 } as const,
          depth: 10,
        };
      }),
      analyzeMultiPV: jest.fn(async (fen: string, _depth: number, mpv: number) => {
        // Spread 250cp между best и second (uniqueness ok).
        const first = firstLegalUci(fen);
        const lines = [
          {
            pv: first,
            score: { type: 'cp', value: 400 } as const,
            bestMove: first,
          },
          {
            pv: 'a1a1',
            score: { type: 'cp', value: 150 } as const,
            bestMove: 'a1a1',
          },
        ];
        return lines.slice(0, mpv);
      }),
    };

    const inserted: PuzzleRecord[] = [];
    const insertPuzzle = jest.fn(async (p: PuzzleRecord) => {
      inserted.push(p);
      return true;
    });

    const fakePg = {
      query: jest
        .fn<
          Promise<{ rows: unknown[] }>,
          [string, unknown[]]
        >()
        .mockResolvedValueOnce({
          rows: [
            {
              id: '00000000-0000-0000-0000-000000000001',
              pgn,
              white_elo: 1800,
              black_elo: 1800,
              ply_count: 22,
              time_control_category: 'classical',
            },
          ],
        })
        .mockResolvedValue({ rows: [] }),
    };

    const opts = defaultGeneratorOptions({
      maxGames: 1,
      depth: 10,
      multiPV: 2,
      minSpread: 150,
      minEvalDrop: 200,
      minLineLength: 1,
      maxLineLength: 3,
      startPly: 20,
    });

    const stats = await runPuzzleGenerator({
      pg: fakePg as never,
      engine,
      options: { ...opts, insertPuzzle },
    });

    expect(stats.gamesProcessed).toBe(1);
    expect(stats.positionsAnalyzed).toBeGreaterThan(0);
    expect(stats.inserted).toBeGreaterThanOrEqual(1);
    expect(insertPuzzle).toHaveBeenCalled();
    const p = inserted[0];
    expect(p.source).toBe('generated');
    expect(p.sourceType).toBe('archive_game');
    expect(p.sourceId).toBe('00000000-0000-0000-0000-000000000001');
    expect(p.depth).toBe(10);
    expect(p.gap).toBeGreaterThanOrEqual(150);
    expect(typeof p.themes).toBe('string');
  });

  it('фильтр: bullet партия пропускается', async () => {
    const pgn = '1. e4 e5 2. Nf3 Nc6 3. Bb5';
    const engine: EngineApi = {
      analyze: jest.fn(),
      analyzeMultiPV: jest.fn(),
    };
    const insertPuzzle = jest.fn(async () => true);
    const fakePg = {
      query: jest
        .fn<Promise<{ rows: unknown[] }>, [string, unknown[]]>()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'g-bullet',
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
    expect(stats.positionsAnalyzed).toBe(0); // partия отфильтрована до анализа
    expect(insertPuzzle).not.toHaveBeenCalled();
  });

  it('фильтр: оба Elo < minRating пропускается', async () => {
    const pgn = '1. e4 e5 2. Nf3 Nc6 3. Bb5';
    const engine: EngineApi = {
      analyze: jest.fn(),
      analyzeMultiPV: jest.fn(),
    };
    const insertPuzzle = jest.fn(async () => true);
    const fakePg = {
      query: jest
        .fn<Promise<{ rows: unknown[] }>, [string, unknown[]]>()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'g-low',
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
    expect(stats.gamesProcessed).toBe(1);
    expect(stats.positionsAnalyzed).toBe(0);
    expect(insertPuzzle).not.toHaveBeenCalled();
  });
});
