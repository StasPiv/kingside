/**
 * KS-2156. Тесты lifecycle-инвариантов `TwicImporter.runForIssue`:
 *   - signal.aborted → импорт прерывается, возвращает status='failed';
 *   - unhandled exception в chunk-loop → archive_imports помечается failed
 *     (а не остаётся в `running` навсегда, как было до фикса).
 *   - archiveGame.create с транзиентной ошибкой P1001 — retryWithBackoff
 *     повторяет до успеха, импорт идёт дальше.
 */

import AdmZip from 'adm-zip';
import {
  TwicImporter,
  type ArchiveSourceRow,
  type ImportResult,
} from './twic.importer';
import type { ArchivePositionWriterService } from '../archive-position-writer.service';
import type { PositionIndexerService } from '../position-indexer.service';
import type { ArchiveImportMetricsService } from '../archive-import-metrics.service';

function makePgn(white: string, black: string, round: string, moves: string): string {
  return [
    '[Event "Test"]',
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

interface ImportRow {
  id: string;
  status: string;
  error: string | null;
  finishedAt: Date | null;
  gamesAdded: number;
  gamesParsed: number;
  gamesSkipped: number;
}

function fakePrisma(opts: {
  /** Если задано — `archiveGame.create` бросает указанную ошибку столько раз. */
  createThrowTimes?: number;
  createThrowError?: Error & { code?: string };
}) {
  const imports: ImportRow[] = [];
  let importSeq = 0;
  let gameSeq = 0;
  const createdGames: string[] = [];
  let throwsLeft = opts.createThrowTimes ?? 0;

  return {
    imports,
    createdGames,
    archiveImport: {
      create: jest.fn(async ({ data }: { data: { fileName?: string } }) => {
        importSeq++;
        const row: ImportRow = {
          id: `import-${importSeq}`,
          status: 'running',
          error: null,
          finishedAt: null,
          gamesAdded: 0,
          gamesParsed: 0,
          gamesSkipped: 0,
          ...((data as unknown) as Partial<ImportRow>),
        };
        imports.push(row);
        return row;
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<ImportRow>;
        }) => {
          const row = imports.find((r) => r.id === where.id);
          if (!row) throw new Error(`import not found: ${where.id}`);
          Object.assign(row, data);
          return row;
        },
      ),
    },
    archiveGame: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async () => {
        if (throwsLeft > 0 && opts.createThrowError) {
          throwsLeft--;
          throw opts.createThrowError;
        }
        gameSeq++;
        const id = `game-${gameSeq}`;
        createdGames.push(id);
        return { id };
      }),
    },
    archiveSource: {
      update: jest.fn(async () => ({})),
    },
  };
}

const sourceRow: ArchiveSourceRow = {
  id: 'src',
  code: 'twic',
  cursor: '1641',
};

describe('TwicImporter — KS-2156 lifecycle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    restoreFetch();
  });

  it('signal.aborted ДО старта → status=failed, fetch НЕ вызывается', async () => {
    const prisma = fakePrisma({});
    const fetchMock = stubFetch(Buffer.from('unused'));

    const importer = new TwicImporter(
      prisma as never,
      sourceRow,
      fakeWriter(),
      fakeIndexer(),
      fakeMetrics(),
    );

    const ac = new AbortController();
    ac.abort(new Error('lock lost: token mismatch'));

    const result = await importer.runAdHoc(1639, { signal: ac.signal });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/import aborted: lock lost/);
    // ВАЖНО: download НЕ начинался.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.archiveImport.create).not.toHaveBeenCalled();
  });

  it('try/finally: ошибка в archiveGame.create без P2002 → archive_imports помечен failed', async () => {
    const fatalErr = new Error('fatal: simulated DB crash');
    // Бросаем 10 раз, что заведомо больше maxAttempts retry (5). Код P1001
    // — транзиентный, retry попробует всё, потом ошибка пробросится в
    // outer catch.
    const transient = Object.assign(fatalErr, { code: 'P1001' });

    const prisma = fakePrisma({
      createThrowTimes: 100,
      createThrowError: transient,
    });
    stubFetch(makeZipBuffer(makePgn('A', 'B', '1', '1. e4 e5'), 'twic1639.pgn'));

    const importer = new TwicImporter(
      prisma as never,
      sourceRow,
      fakeWriter(),
      fakeIndexer(),
      fakeMetrics(),
    );

    const result: ImportResult = await importer.runAdHoc(1639);

    // archive_imports.update вызван с status='failed' и непустым error.
    expect(prisma.imports).toHaveLength(1);
    const row = prisma.imports[0];
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/fatal: simulated DB crash/);
    expect(row.finishedAt).toBeInstanceOf(Date);

    expect(result.status).toBe('failed');
    expect(result.importId).toBe(row.id);
  });

  it('archiveGame.create P1001 retry → после транзиентного флапа импорт продолжается', async () => {
    // Бросаем P1001 ровно 2 раза, потом — успех. retry с backoff
    // initialDelayMs/factor должен пройти.
    const transient = Object.assign(new Error('Cant reach DB'), {
      code: 'P1001',
    }) as Error & { code: string };

    const prisma = fakePrisma({
      createThrowTimes: 2,
      createThrowError: transient,
    });
    stubFetch(makeZipBuffer(makePgn('A', 'B', '1', '1. e4 e5'), 'twic1639.pgn'));

    const importer = new TwicImporter(
      prisma as never,
      sourceRow,
      fakeWriter(),
      fakeIndexer(),
      fakeMetrics(),
    );

    const result = await importer.runAdHoc(1639);

    expect(result.status).toBe('ok');
    expect(result.gamesAdded).toBe(1);
    // create вызвался 3 раза: 2 throw + 1 успех.
    expect(prisma.archiveGame.create).toHaveBeenCalledTimes(3);
    expect(prisma.imports).toHaveLength(1);
    expect(prisma.imports[0].status).toBe('ok');
  });
});
