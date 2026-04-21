import { filterAlreadyImported, toBytes } from './dedup';
import type { ParsedGame, GameMoveStep } from './pgn-utils';

function mkGame(contentHashHex: string): ParsedGame {
  const contentHash = Buffer.from(contentHashHex, 'hex');
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
    playedAt: null,
    result: '1-0',
    eco: null,
    opening: null,
    plyCount: 0,
    moves: [] as GameMoveStep[],
    finalFen: '',
    contentHash,
    raw: '',
    timeControl: null,
    category: 'unknown',
    isClassical: false,
    classificationReason: 'legacy_otb',
  };
}

describe('filterAlreadyImported', () => {
  it('возвращает все партии, если ни одной нет в БД', async () => {
    const a = mkGame('aa'.repeat(20));
    const b = mkGame('bb'.repeat(20));
    const prisma = {
      archiveGame: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const result = await filterAlreadyImported(prisma as never, [a, b]);
    expect(result).toEqual([a, b]);
    expect(prisma.archiveGame.findMany).toHaveBeenCalledTimes(1);
  });

  it('отбрасывает партии, чей content_hash уже в БД', async () => {
    const a = mkGame('aa'.repeat(20));
    const b = mkGame('bb'.repeat(20));
    const c = mkGame('cc'.repeat(20));
    const prisma = {
      archiveGame: {
        findMany: jest.fn().mockResolvedValue([
          { contentHash: Buffer.from('aa'.repeat(20), 'hex') },
          { contentHash: Buffer.from('cc'.repeat(20), 'hex') },
        ]),
      },
    };
    const result = await filterAlreadyImported(prisma as never, [a, b, c]);
    expect(result.map((g) => g.contentHash.toString('hex'))).toEqual([
      'bb'.repeat(20),
    ]);
  });

  it('на пустом входе не делает запрос', async () => {
    const prisma = {
      archiveGame: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const result = await filterAlreadyImported(prisma as never, []);
    expect(result).toEqual([]);
    expect(prisma.archiveGame.findMany).not.toHaveBeenCalled();
  });

  it('KS-1621 Scenario: повторный прогон того же батча → все отфильтрованы', async () => {
    const games = [
      mkGame('aa'.repeat(20)),
      mkGame('bb'.repeat(20)),
      mkGame('cc'.repeat(20)),
    ];
    const prisma = {
      archiveGame: {
        findMany: jest.fn().mockResolvedValue(
          games.map((g) => ({ contentHash: Buffer.from(g.contentHash) })),
        ),
      },
    };
    const result = await filterAlreadyImported(prisma as never, games);
    expect(result).toEqual([]);
  });

  it('KS-1621 Scenario: 900 старых + 100 новых → вернуть только 100', async () => {
    const old900 = Array.from({ length: 900 }, (_, i) =>
      mkGame(i.toString(16).padStart(40, '0')),
    );
    const new100 = Array.from({ length: 100 }, (_, i) =>
      mkGame((i + 1000).toString(16).padStart(40, '0')),
    );
    const prisma = {
      archiveGame: {
        findMany: jest.fn().mockResolvedValue(
          old900.map((g) => ({ contentHash: Buffer.from(g.contentHash) })),
        ),
      },
    };
    const result = await filterAlreadyImported(prisma as never, [
      ...old900,
      ...new100,
    ]);
    expect(result).toHaveLength(100);
    expect(result).toEqual(new100);
  });
});

describe('toBytes', () => {
  it('копирует Buffer в чистый Uint8Array (без SharedArrayBuffer)', () => {
    const g = mkGame('00ff11ee22dd33cc44bb55aa66997788');
    const bytes = toBytes(g);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes).toString('hex')).toBe(
      '00ff11ee22dd33cc44bb55aa66997788',
    );
  });
});
