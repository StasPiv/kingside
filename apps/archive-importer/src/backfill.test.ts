import { describe, expect, it, vi } from 'vitest';
import {
  backfillLoop,
  parseArgs,
  type BackfillPrisma,
  type BackfillWriter,
} from './backfill.js';
import type { PositionRow } from './position-row-builder.js';

const MIN_PGN =
  '[Event "t"]\n[Site "s"]\n[Date "2025.01.01"]\n[Round "1"]\n' +
  '[White "W"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 1-0\n';

function fakePrisma(gamesPerCall: unknown[][]): BackfillPrisma {
  let call = 0;
  return {
    archiveGame: {
      async count() {
        return gamesPerCall[0]?.length ?? 0;
      },
      async findMany() {
        const batch = gamesPerCall[call] ?? [];
        call += 1;
        return batch;
      },
    },
    async $disconnect() {},
  };
}

function fakeWriter(impl: Partial<BackfillWriter> = {}): BackfillWriter {
  return {
    async write(_rows: PositionRow[]) {
      return _rows.length;
    },
    async close() {},
    ...impl,
  };
}

describe('backfill parseArgs', () => {
  it('без аргументов → mode=default, batch 2000, resume=null', () => {
    const opts = parseArgs([]);
    expect(opts).toEqual({
      mode: 'default',
      batchSize: 2000,
      resumeFrom: null,
    });
  });

  it('--mode=extend → mode=extend', () => {
    expect(parseArgs(['--mode=extend']).mode).toBe('extend');
  });

  it('--mode=default явно → mode=default', () => {
    expect(parseArgs(['--mode=default']).mode).toBe('default');
  });

  it('--ignore-existing-game-ids → mode=extend (алиас из ТЗ)', () => {
    expect(parseArgs(['--ignore-existing-game-ids']).mode).toBe('extend');
  });

  it('--mode=unknown бросает ошибку', () => {
    expect(() => parseArgs(['--mode=bad'])).toThrow(/Unknown --mode=bad/);
  });

  it('--batch-size=500 применяется', () => {
    expect(parseArgs(['--batch-size=500']).batchSize).toBe(500);
  });

  it('--batch-size=0 бросает ошибку', () => {
    expect(() => parseArgs(['--batch-size=0'])).toThrow(/Invalid --batch-size/);
  });

  it('--batch-size=abc бросает ошибку', () => {
    expect(() => parseArgs(['--batch-size=abc'])).toThrow(/Invalid --batch-size/);
  });

  it('--resume-from=<uuid> применяется', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    expect(parseArgs([`--resume-from=${uuid}`]).resumeFrom).toBe(uuid);
  });

  it('--resume-from= (пусто) → null', () => {
    expect(parseArgs(['--resume-from=']).resumeFrom).toBeNull();
  });

  it('комбинация: --mode=extend --batch-size=1000 --resume-from=<uuid>', () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(
      parseArgs([
        '--mode=extend',
        '--batch-size=1000',
        `--resume-from=${uuid}`,
      ]),
    ).toEqual({
      mode: 'extend',
      batchSize: 1000,
      resumeFrom: uuid,
    });
  });

  it('неизвестные флаги игнорируются', () => {
    const opts = parseArgs(['--foo=bar', '--mode=extend']);
    expect(opts.mode).toBe('extend');
  });
});

describe('backfillLoop — silent-fail fix (KS-1640)', () => {
  const gameRow = {
    id: '00000000-0000-4000-a000-000000000001',
    pgn: MIN_PGN,
    whiteElo: 2400,
    blackElo: 2500,
    playedAt: new Date('2025-01-01T00:00:00Z'),
    result: '1-0',
    whiteTitle: null,
    blackTitle: null,
    whiteName: 'W',
    blackName: 'B',
    event: null,
    site: null,
    round: '1',
    date: '2025.01.01',
    eco: null,
    opening: null,
    plyCount: 1,
    finalFen: null,
  };

  it('writer.write throw → backfillLoop rejects с тем же Error (не silent exit 0)', async () => {
    const sslError = new Error(
      'no pg_hba.conf entry for host "10.0.1.197", no encryption',
    );
    const prisma = fakePrisma([[gameRow]]);
    const writer = fakeWriter({
      write: vi.fn().mockRejectedValue(sslError),
    });

    await expect(
      backfillLoop(
        prisma,
        writer,
        { mode: 'extend', batchSize: 100, resumeFrom: null },
        async () => new Set(),
      ),
    ).rejects.toThrow(/no pg_hba\.conf entry/);
  });

  it('успешный прогон завершает loop и считает строки', async () => {
    const prisma = fakePrisma([[gameRow], []]);
    const writer = fakeWriter();

    await expect(
      backfillLoop(
        prisma,
        writer,
        { mode: 'extend', batchSize: 100, resumeFrom: null },
        async () => new Set(),
      ),
    ).resolves.toBeUndefined();
  });

  it('в default-mode существующие game_id skipped, loop не падает', async () => {
    const prisma = fakePrisma([[gameRow], []]);
    const writer = fakeWriter({
      write: vi.fn().mockResolvedValue(0),
    });

    await backfillLoop(
      prisma,
      writer,
      { mode: 'default', batchSize: 100, resumeFrom: null },
      async () => new Set([gameRow.id]),
    );

    // write не вызывался, т.к. все партии skipped
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('throw без message тоже оборачивается в Error и re-throws', async () => {
    const prisma = fakePrisma([[gameRow]]);
    const writer = fakeWriter({
      write: vi.fn().mockRejectedValue('bare string rejection'),
    });

    await expect(
      backfillLoop(
        prisma,
        writer,
        { mode: 'extend', batchSize: 100, resumeFrom: null },
        async () => new Set(),
      ),
    ).rejects.toThrow(/bare string rejection/);
  });
});
