/**
 * KS-2180. Тесты расширенного логирования: per-error WARN с code/headers
 * + breakdown по error-кодам в финале insert-фазы.
 *
 * Progress-логи (каждые 500 партий / 30 сек) уже косвенно проверяются
 * в `twic.importer.streaming.spec.ts` (3 строки `insert progress` на
 * 1500-партийном fixture'е). Здесь — pure unit-проверки на:
 *   1. Первый error нового кода → WARN с code и headers партии.
 *   2. Повторный error того же кода → НЕ дублирует WARN (только counter).
 *   3. Финальный `insert errors breakdown` агрегирует все коды.
 */
import AdmZip from 'adm-zip';
import { TwicImporter, type ArchiveSourceRow } from './twic.importer';
import type { ArchivePositionWriterService } from '../archive-position-writer.service';
import type { PositionIndexerService } from '../position-indexer.service';
import type { ArchiveImportMetricsService } from '../archive-import-metrics.service';

function makePgn(
  white: string,
  black: string,
  round: string,
  moves: string,
): string {
  return [
    '[Event "Test Event"]',
    '[Site "Test"]',
    `[Round "${round}"]`,
    '[Date "2025.01.01"]',
    `[White "${white}"]`,
    `[Black "${black}"]`,
    '[Result "1-0"]',
    '',
    `${moves} 1-0`,
    '',
  ].join('\n');
}

function makeZipBuffer(pgn: string, fileName: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(fileName, Buffer.from(pgn, 'utf-8'));
  return zip.toBuffer();
}

function stubFetch(buffer: Buffer): jest.Mock {
  const mock = jest.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ),
  }));
  (globalThis as { fetch: unknown }).fetch = mock;
  return mock;
}

function restoreFetch(): void {
  delete (globalThis as { fetch?: unknown }).fetch;
}

function fakeMetrics(): ArchiveImportMetricsService {
  return {
    archiveImportGamesTotal: { inc: jest.fn() },
    archiveGamesByCategoryTotal: { inc: jest.fn() },
    archiveRejectedUnknownReasonTotal: { inc: jest.fn() },
    archiveImportedNonClassicalTotal: { inc: jest.fn() },
    archiveClassicalRatio: { set: jest.fn() },
  } as unknown as ArchiveImportMetricsService;
}

function fakeIndexer(): PositionIndexerService {
  return {
    index: jest.fn().mockResolvedValue(undefined),
  } as unknown as PositionIndexerService;
}

function fakeWriter(): ArchivePositionWriterService {
  return {
    write: jest.fn().mockResolvedValue(undefined),
  } as unknown as ArchivePositionWriterService;
}

interface Row {
  id: string;
  status: string;
}

/**
 * Mock prisma, в котором `archiveGame.create` бросает по-разному в
 * зависимости от номера попытки. Список ошибок передаётся как
 * `errorScript`: index-th попытка → бросает `errorScript[index]` если
 * не undefined, иначе успех.
 */
function fakePrismaWithScript(errorScript: Array<unknown | undefined>) {
  const imports: Row[] = [];
  let createIdx = 0;
  let importSeq = 0;
  return {
    imports,
    archiveImport: {
      create: jest.fn(async () => {
        importSeq++;
        const row: Row = { id: `import-${importSeq}`, status: 'running' };
        imports.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = imports.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    archiveGame: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async () => {
        const err = errorScript[createIdx];
        createIdx++;
        if (err) throw err;
        return { id: `g-${createIdx}` };
      }),
    },
    archiveSource: { update: jest.fn(async () => ({})) },
  };
}

const sourceRow: ArchiveSourceRow = { id: 'src', code: 'twic', cursor: '1641' };

const pgn3 = [
  makePgn('Alice', 'Bob', '1', '1. e4 e5 2. Nf3 Nc6'),
  makePgn('Carol', 'Dan', '2', '1. d4 d5 2. c4 e6'),
  makePgn('Eve', 'Frank', '3', '1. c4 c5 2. Nc3 Nc6'),
].join('\n\n');
const zipBuf = makeZipBuffer(pgn3, 'twic1639.pgn');

describe('TwicImporter — KS-2180 per-error WARN', () => {
  afterEach(() => {
    restoreFetch();
    jest.restoreAllMocks();
  });

  it('первая partition с code=FOO_ERR → WARN с code + headers; вторая того же кода → тихий counter', async () => {
    // 3 партии в zip: первая бросает FOO_ERR, вторая FOO_ERR, третья ok.
    const fooErr1: Error & { code: string } = Object.assign(new Error('msg-1'), {
      code: 'FOO_ERR',
    });
    const fooErr2: Error & { code: string } = Object.assign(new Error('msg-2'), {
      code: 'FOO_ERR',
    });
    const prisma = fakePrismaWithScript([fooErr1, fooErr2, undefined]);
    stubFetch(zipBuf);
    const importer = new TwicImporter(
      prisma as never,
      sourceRow,
      fakeWriter(),
      fakeIndexer(),
      fakeMetrics(),
    );

    // Шпион на logger.
    const warnSpy = jest
      .spyOn(
        (importer as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await importer.runAdHoc(1639);

    // FIRST WARN — про FOO_ERR с headers первой партии.
    const firstWarn = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('FIRST error code=FOO_ERR'),
    );
    expect(firstWarn).toBeDefined();
    expect(String(firstWarn![0])).toContain('white="Alice"');
    expect(String(firstWarn![0])).toContain('black="Bob"');

    // ВТОРАЯ FOO_ERR — НЕ должна породить ещё один FIRST WARN.
    const firstWarnsCount = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('FIRST error code=FOO_ERR'),
    ).length;
    expect(firstWarnsCount).toBe(1);

    // Финальный breakdown — `FOO_ERR=2`.
    const breakdown = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('insert errors breakdown'),
    );
    expect(breakdown).toBeDefined();
    expect(String(breakdown![0])).toContain('FOO_ERR=2');
    expect(String(breakdown![0])).toContain('total=2');
  });

  it('разные коды ошибок → разные FIRST WARN; breakdown содержит обе записи', async () => {
    const errA = Object.assign(new Error('A'), { code: 'CODE_A' });
    const errB = Object.assign(new Error('B'), { code: 'CODE_B' });
    const prisma = fakePrismaWithScript([errA, errB, undefined]);
    stubFetch(zipBuf);
    const importer = new TwicImporter(
      prisma as never,
      sourceRow,
      fakeWriter(),
      fakeIndexer(),
      fakeMetrics(),
    );
    const warnSpy = jest
      .spyOn(
        (importer as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await importer.runAdHoc(1639);

    const firstWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('FIRST error code='),
    );
    expect(firstWarns).toHaveLength(2);
    expect(firstWarns.map((c) => String(c[0])).join('\n')).toMatch(/CODE_A/);
    expect(firstWarns.map((c) => String(c[0])).join('\n')).toMatch(/CODE_B/);

    const breakdown = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('insert errors breakdown'),
    );
    expect(String(breakdown![0])).toContain('CODE_A=1');
    expect(String(breakdown![0])).toContain('CODE_B=1');
    expect(String(breakdown![0])).toContain('total=2');
  });

  it('успешный импорт без ошибок → breakdown НЕ выводится, только финальный progress', async () => {
    const prisma = fakePrismaWithScript([undefined, undefined, undefined]);
    stubFetch(zipBuf);
    const importer = new TwicImporter(
      prisma as never,
      sourceRow,
      fakeWriter(),
      fakeIndexer(),
      fakeMetrics(),
    );
    const warnSpy = jest
      .spyOn(
        (importer as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    const logSpy = jest
      .spyOn(
        (importer as unknown as { logger: { log: (m: string) => void } }).logger,
        'log',
      )
      .mockImplementation(() => undefined);

    await importer.runAdHoc(1639);

    const breakdownCalls = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('insert errors breakdown'),
    );
    expect(breakdownCalls).toHaveLength(0);

    // Финальный progress — есть.
    const progressCalls = logSpy.mock.calls.filter((c) =>
      String(c[0]).includes('insert progress'),
    );
    expect(progressCalls.length).toBeGreaterThanOrEqual(1);
    expect(String(progressCalls[progressCalls.length - 1][0])).toContain(
      'errors=0',
    );
  });

  it('ошибка без code (например generic Error) → код = "unknown" в breakdown', async () => {
    const prisma = fakePrismaWithScript([new Error('generic'), undefined, undefined]);
    stubFetch(zipBuf);
    const importer = new TwicImporter(
      prisma as never,
      sourceRow,
      fakeWriter(),
      fakeIndexer(),
      fakeMetrics(),
    );
    const warnSpy = jest
      .spyOn(
        (importer as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await importer.runAdHoc(1639);

    const breakdown = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('insert errors breakdown'),
    );
    expect(String(breakdown![0])).toContain('unknown=1');
  });
});
