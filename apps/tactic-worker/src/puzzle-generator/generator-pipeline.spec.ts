/**
 * KS-2431 (WDL pivot). Integration-light test pipeline'а с моком engine,
 * который возвращает заранее заданный WDL. Проверяем что:
 *   - blunder-фильтр (X) срабатывает на ΔWDL.
 *   - spread-фильтр (Y) срабатывает на разности PV1-PV2.
 *   - инвариант accountedFor=analyzed соблюдён.
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

describe('runPuzzleGenerator (WDL)', () => {
  const buildPgn = () => {
    const c = new Chess();
    const moves = [
      'e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'd3', 'd6',
      'O-O', 'Nf6', 'h3', 'h6', 'Nc3', 'Bg4', 'Be3', 'Bxe3',
      'fxe3', 'Qd7', 'a3', 'Bxh3', 'gxh3', 'Qxh3',
    ];
    for (const m of moves) c.move(m);
    return c.pgn();
  };

  it('детектит зевок по WDL и вставляет puzzle', async () => {
    const pgn = buildPgn();
    let analyzeCalls = 0;
    const engine: EngineApi = {
      analyzePositionWdl: jest.fn(async (fen: string) => {
        analyzeCalls++;
        // Первая позиция (стартовый WDL до startPly): нейтрально.
        // Когда pipeline впервые вызовет engine после startPly — это
        // позиция ПОСЛЕ хода, и моки делают «зевок» на одной из них.
        // Стратегия: возвращаем PV1 с очень высоким WDL за новую
        // сторону на ходу (= противник сходившего) и PV2 с низким —
        // это создаст и blunder (с инверсией) и spread.
        const first = firstLegalUci(fen);
        return [
          {
            pv: first,
            score: { type: 'cp', value: 400 } as const,
            bestMove: first,
            wdl: { w: 800, d: 200, l: 0 },
          },
          {
            pv: 'a1a1',
            score: { type: 'cp', value: 50 } as const,
            bestMove: 'a1a1',
            wdl: { w: 200, d: 800, l: 0 },
          },
        ];
      }),
    };

    const inserted: PuzzleRecord[] = [];
    const insertPuzzle = jest.fn(async (p: PuzzleRecord) => {
      inserted.push(p);
      return true;
    });
    const fakePg = {
      query: jest
        .fn<Promise<{ rows: unknown[] }>, [string, unknown[]]>()
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
      blunderDelta: 0.5,
      spreadDelta: 0.3,
      minLineLength: 1,
      maxLineLength: 4,
      startPly: 20,
      engineLimit: { depth: 8, timeMs: 100, nodes: 50_000 },
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
    expect(p.gap).toBeGreaterThanOrEqual(30); // spread*100 ≥ 30
    expect(typeof p.themes).toBe('string');
    // accountedFor invariant
    const sumDrops = Object.values(stats.drops).reduce((a, b) => a + b, 0);
    expect(stats.inserted + sumDrops).toBe(stats.positionsAnalyzed);
  });

  it('фильтр: bullet → пропуск', async () => {
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
