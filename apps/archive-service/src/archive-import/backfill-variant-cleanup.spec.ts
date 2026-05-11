import {
  runBackfillVariantCleanup,
  parseBackfillVariantArgs,
  type BackfillVariantPrisma,
} from './backfill-variant-cleanup';

const STD_PGN = `[Event "X"]
[White "A"]
[Black "B"]
[Result "1-0"]

1. e4 e5 1-0
`;

const FRC_PGN = `[Event "X"]
[Variant "Chess960"]
[White "A"]
[Black "B"]
[Result "1-0"]

1. e4 1-0
`;

const CRAZY_PGN = `[Event "X"]
[Variant "Crazyhouse"]
[White "A"]
[Black "B"]
[Result "1-0"]

1. e4 1-0
`;

/**
 * In-memory mock Prisma archiveGame. Не использует реальной БД —
 * только массив строк { id, pgn }. После deleteMany удаляет.
 */
function makePrisma(initial: Array<{ id: string; pgn: string }>): {
  prisma: BackfillVariantPrisma;
  rows: Array<{ id: string; pgn: string }>;
  deleteCalls: string[][];
} {
  const rows = [...initial].sort((a, b) => a.id.localeCompare(b.id));
  const deleteCalls: string[][] = [];
  const prisma: BackfillVariantPrisma = {
    archiveGame: {
      findMany: async (args) => {
        const filter = args.where?.id?.gt;
        const filtered = filter
          ? rows.filter((r) => r.id > filter)
          : rows.slice();
        return filtered.slice(0, args.take);
      },
      deleteMany: async (args) => {
        const ids = args.where.id.in;
        deleteCalls.push([...ids]);
        let count = 0;
        for (const id of ids) {
          const i = rows.findIndex((r) => r.id === id);
          if (i >= 0) {
            rows.splice(i, 1);
            count++;
          }
        }
        return { count };
      },
    },
  };
  return { prisma, rows, deleteCalls };
}

describe('parseBackfillVariantArgs (KS-2782)', () => {
  it('пустые args → defaults', () => {
    const o = parseBackfillVariantArgs([]);
    expect(o).toEqual({});
  });

  it('--dry-run → dryRun=true', () => {
    const o = parseBackfillVariantArgs(['--dry-run']);
    expect(o.dryRun).toBe(true);
  });

  it('--batch-size=500 → batchSize=500', () => {
    const o = parseBackfillVariantArgs(['--batch-size=500']);
    expect(o.batchSize).toBe(500);
  });

  it('--log-every=2 → logEveryNBatches=2', () => {
    const o = parseBackfillVariantArgs(['--log-every=2']);
    expect(o.logEveryNBatches).toBe(2);
  });

  it('неизвестный флаг → throw', () => {
    expect(() => parseBackfillVariantArgs(['--unknown'])).toThrow(
      /Unknown CLI argument/,
    );
  });

  it('--batch-size=0 → throw', () => {
    expect(() => parseBackfillVariantArgs(['--batch-size=0'])).toThrow(
      /Invalid --batch-size/,
    );
  });
});

describe('runBackfillVariantCleanup (KS-2782)', () => {
  it('пустая БД → checked=0 removed=0', async () => {
    const { prisma, rows, deleteCalls } = makePrisma([]);
    const logs: string[] = [];
    const s = await runBackfillVariantCleanup(prisma, (m) => logs.push(m), {
      batchSize: 10,
    });
    expect(s.checked).toBe(0);
    expect(s.removed).toBe(0);
    expect(rows.length).toBe(0);
    expect(deleteCalls.length).toBe(0);
  });

  it('только standard партии → ничего не удаляется', async () => {
    const { prisma, rows } = makePrisma([
      { id: '01', pgn: STD_PGN },
      { id: '02', pgn: STD_PGN },
      { id: '03', pgn: STD_PGN },
    ]);
    const s = await runBackfillVariantCleanup(prisma, () => {}, {
      batchSize: 10,
    });
    expect(s.checked).toBe(3);
    expect(s.removed).toBe(0);
    expect(rows.length).toBe(3);
  });

  it('смесь standard + Chess960 → удаляются только Chess960', async () => {
    const { prisma, rows, deleteCalls } = makePrisma([
      { id: '01', pgn: STD_PGN },
      { id: '02', pgn: FRC_PGN },
      { id: '03', pgn: STD_PGN },
      { id: '04', pgn: CRAZY_PGN },
      { id: '05', pgn: FRC_PGN },
    ]);
    const s = await runBackfillVariantCleanup(prisma, () => {}, {
      batchSize: 10,
    });
    expect(s.checked).toBe(5);
    expect(s.removed).toBe(3);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.id).sort()).toEqual(['01', '03']);
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0].sort()).toEqual(['02', '04', '05']);
  });

  it('dry-run: считает, но не удаляет', async () => {
    const { prisma, rows, deleteCalls } = makePrisma([
      { id: '01', pgn: STD_PGN },
      { id: '02', pgn: FRC_PGN },
      { id: '03', pgn: FRC_PGN },
    ]);
    const s = await runBackfillVariantCleanup(prisma, () => {}, {
      batchSize: 10,
      dryRun: true,
    });
    expect(s.checked).toBe(3);
    expect(s.removed).toBe(2);
    expect(rows.length).toBe(3); // ничего не удалено
    expect(deleteCalls.length).toBe(0);
  });

  it('batching: 5 строк × batchSize=2 → 3 batch (2+2+1)', async () => {
    const { prisma } = makePrisma([
      { id: '01', pgn: STD_PGN },
      { id: '02', pgn: FRC_PGN },
      { id: '03', pgn: STD_PGN },
      { id: '04', pgn: FRC_PGN },
      { id: '05', pgn: STD_PGN },
    ]);
    const s = await runBackfillVariantCleanup(prisma, () => {}, {
      batchSize: 2,
    });
    expect(s.batches).toBe(3);
    expect(s.checked).toBe(5);
    expect(s.removed).toBe(2);
  });

  it('lastCursor = id последней обработанной записи', async () => {
    const { prisma } = makePrisma([
      { id: '01', pgn: STD_PGN },
      { id: '02', pgn: STD_PGN },
      { id: '03', pgn: STD_PGN },
    ]);
    const s = await runBackfillVariantCleanup(prisma, () => {}, {
      batchSize: 10,
    });
    expect(s.lastCursor).toBe('03');
  });

  it('логирует через logEveryNBatches', async () => {
    const { prisma } = makePrisma(
      Array.from({ length: 20 }, (_, i) => ({
        id: String(i + 1).padStart(3, '0'),
        pgn: STD_PGN,
      })),
    );
    const logs: string[] = [];
    await runBackfillVariantCleanup(prisma, (m) => logs.push(m), {
      batchSize: 2,
      logEveryNBatches: 5,
    });
    // 20 / 2 = 10 batch; прогресс на 5 и 10 + start + done.
    const progressLogs = logs.filter((l) => l.includes('progress:'));
    expect(progressLogs.length).toBe(2);
  });
});
