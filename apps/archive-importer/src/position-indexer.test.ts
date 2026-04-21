import { describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import type { PrismaClient } from '@kingside/archive-db';
import { PositionIndexer } from './position-indexer.js';
import type { ParsedGame, GameMoveStep } from './pgn-utils.js';

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

/**
 * Мок Prisma, наблюдающий за `$executeRaw`. `$transaction(arr)` — выполняет
 * массив промисов параллельно, как и настоящая Prisma.
 */
function mockPrisma(): { prisma: PrismaClient; executeRaw: ReturnType<typeof vi.fn> } {
  const executeRaw = vi.fn(async () => 1);
  const prisma = {
    $executeRaw: executeRaw,
    $transaction: vi.fn(async (arr: Promise<unknown>[]) => Promise.all(arr)),
  } as unknown as PrismaClient;
  return { prisma, executeRaw };
}

describe('PositionIndexer — KS-1624 SetUp handling', () => {
  it('Gherkin: SetUp-партия не инкрементирует позиции в position_stats', async () => {
    const nonStandard =
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const moves = stepsFromUci(['e7e5', 'g1f3', 'b8c6'], nonStandard);
    const game = mkGame({ moves, plyCount: moves.length, startFen: nonStandard });

    const { prisma, executeRaw } = mockPrisma();
    const indexer = new PositionIndexer(prisma, 'test');
    await indexer.index([game]);

    // Ни одна дельта не применилась — SetUp-партия полностью пропускается.
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('Gherkin: обычная партия (startFen undefined) инкрементирует позиции', async () => {
    const moves = stepsFromUci(['e2e4', 'e7e5', 'g1f3']);
    const game = mkGame({ moves, plyCount: moves.length });

    const { prisma, executeRaw } = mockPrisma();
    const indexer = new PositionIndexer(prisma, 'test');
    await indexer.index([game]);

    // Ровно 3 UPSERT'а — по одному на каждый ply в пределах PLY_LIMIT.
    expect(executeRaw).toHaveBeenCalledTimes(3);
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
    const indexer = new PositionIndexer(prisma, 'test');
    await indexer.index([normal, setup]);

    // Только одна дельта — от обычной партии (ply 1).
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });
});
