import { Chess } from 'chess.js';
import { PositionIndexerService } from './position-indexer.service';
import type { ArchiveImportMetricsService } from './archive-import-metrics.service';
import type { ParsedGame, GameMoveStep } from './pgn-utils';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function stepsFromUci(uciList: string[], startFen?: string): GameMoveStep[] {
  const chess = startFen ? new Chess(startFen) : new Chess();
  const steps: GameMoveStep[] = [];
  for (const u of uciList) {
    const from = u.slice(0, 2);
    const to = u.slice(2, 4);
    const promotion = u.length > 4 ? u.slice(4) : undefined;
    const res = chess.move({ from, to, promotion });
    if (!res) throw new Error(`bad uci: ${u}`);
    steps.push({ uci: u, fenAfter: chess.fen() });
  }
  return steps;
}

function mkGame(overrides: Partial<ParsedGame>): ParsedGame {
  return {
    white: 'W',
    black: 'B',
    whiteElo: 2400,
    blackElo: 2500,
    whiteTitle: null,
    blackTitle: null,
    event: null,
    site: null,
    round: null,
    date: '2025.01.01',
    playedAt: new Date('2025-01-01T00:00:00Z'),
    result: '1-0',
    eco: null,
    opening: null,
    plyCount: overrides.moves?.length ?? 0,
    moves: [],
    finalFen: STARTING_FEN,
    contentHash: Buffer.alloc(20),
    raw: '',
    timeControl: null,
    category: 'classical-legacy',
    isClassical: true,
    classificationReason: 'legacy_otb',
    ...overrides,
  };
}

/** Fake metrics service: пропускает fn() мимо prom-client. */
function fakeMetrics(): ArchiveImportMetricsService {
  return {
    timePositionStatsUpsert: async <T>(_s: string, fn: () => Promise<T>) => fn(),
    timeImport: async <T>(_s: string, fn: () => Promise<T>) => fn(),
    timePositionRowsCopy: async <T>(_s: string, fn: () => Promise<T>) => fn(),
  } as unknown as ArchiveImportMetricsService;
}

/**
 * Мок Prisma surface, наблюдающий за `$executeRaw`. `$transaction(arr)` —
 * выполняет массив промисов параллельно, как и настоящая Prisma.
 */
function mockPrisma(): {
  prisma: { $executeRaw: jest.Mock; $transaction: jest.Mock };
  executeRaw: jest.Mock;
} {
  const executeRaw = jest.fn(async () => 1);
  const prisma = {
    $executeRaw: executeRaw,
    $transaction: jest.fn(async (arr: Promise<unknown>[]) => Promise.all(arr)),
  };
  return { prisma, executeRaw };
}

describe('PositionIndexerService — KS-1624 SetUp handling', () => {
  it('Gherkin: SetUp-партия не инкрементирует позиции в position_stats', async () => {
    const nonStandard =
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const moves = stepsFromUci(['e7e5', 'g1f3', 'b8c6'], nonStandard);
    const game = mkGame({ moves, plyCount: moves.length, startFen: nonStandard });

    const { prisma, executeRaw } = mockPrisma();
    const indexer = new PositionIndexerService(
      null as never,
      fakeMetrics(),
    );
    await indexer.indexWithPrisma(prisma as never, [game], 'test');

    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('Gherkin: обычная партия (startFen undefined) инкрементирует позиции', async () => {
    const moves = stepsFromUci(['e2e4', 'e7e5', 'g1f3']);
    const game = mkGame({ moves, plyCount: moves.length });

    const { prisma, executeRaw } = mockPrisma();
    const indexer = new PositionIndexerService(
      null as never,
      fakeMetrics(),
    );
    await indexer.indexWithPrisma(prisma as never, [game], 'test');

    // Ровно 3 UPSERT'а — по одному на каждый ply в пределах PLY_LIMIT.
    expect(executeRaw).toHaveBeenCalledTimes(3);
  });

  it('KS-2180: каждый chunk applyDeltas порождает progress-лог "[indexer] chunk i/N"', async () => {
    // 1100 уникальных позиций → 3 chunk'а (500/500/100).
    const moves: Array<{ uci: string; fenAfter: string }> = [];
    // Достаточно несколько партий с разными ходами; для unit-теста
    // используем простой пресет — но 1 партия на 3 хода не даст
    // 1100 уникальных. Проще — генерируем синтетические дельты через
    // приватный applyDeltas? Нельзя. Проверим иначе: 2 партии с
    // разными первыми ходами → 2 уникальные позиции → 1 chunk → 1 log.
    const game1 = mkGame({
      moves: stepsFromUci(['e2e4']),
      plyCount: 1,
    });
    const game2 = mkGame({
      moves: stepsFromUci(['d2d4']),
      plyCount: 1,
    });
    const { prisma } = mockPrisma();
    const indexer = new PositionIndexerService(null as never, fakeMetrics());
    const logSpy = jest
      .spyOn(
        (indexer as unknown as { logger: { log: (m: string) => void } }).logger,
        'log',
      )
      .mockImplementation(() => undefined);

    await indexer.indexWithPrisma(prisma as never, [game1, game2], 'test');

    // Стартовый «applyDeltas start: deltas=2 chunks=1 ...».
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/applyDeltas start: deltas=2 chunks=1/),
    );
    // Per-chunk log: «[indexer] chunk 1/1 durationMs=...».
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[indexer\] chunk 1\/1 durationMs=\d+ rows=2/),
    );
  });

  it('смешанный батч: SetUp-партия пропущена, обычная посчитана', async () => {
    const normalMoves = stepsFromUci(['e2e4']);
    const normal = mkGame({ moves: normalMoves, plyCount: normalMoves.length });

    const nonStandard =
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const setupMoves = stepsFromUci(['e7e5'], nonStandard);
    const setup = mkGame({
      moves: setupMoves,
      plyCount: setupMoves.length,
      startFen: nonStandard,
    });

    const { prisma, executeRaw } = mockPrisma();
    const indexer = new PositionIndexerService(
      null as never,
      fakeMetrics(),
    );
    await indexer.indexWithPrisma(prisma as never, [normal, setup], 'test');

    expect(executeRaw).toHaveBeenCalledTimes(1);
  });
});
