/**
 * KS-1687 — streaming/chunked pipeline для `TwicImporter.runForIssue`.
 *
 * Четыре теста-якоря (см. issue KS-1687):
 *   Тест 1 — peak RSS на 8k fixture < 400 MiB (Fargate 512 MiB hard-limit
 *            с запасом на Nest/Prisma baseline + V8 GC headroom).
 *   Тест 2 — dedup / идемпотентность: повторный run того же 8k fixture
 *            даёт `gamesAdded=0, gamesSkipped=8000`.
 *   Тест 3 — chunk-boundary UNIQUE violation: две партии с одинаковым
 *            `content_hash` на разных сторонах chunk-границы — вторая
 *            ловится P2002-веткой → учёт в `gamesSkipped`.
 *   Тест 4 — aggregate audit row: ровно одна строка `archive_imports`
 *            на весь run (не 16 и не N).
 *
 * Тесты 1–2 запускают `test/profile/profile-twic-importer.ts` в отдельном
 * child_process с `--expose-gc` — jest-framework сам держит ~200-300 MiB
 * heap, что «похоронит» измерение peak RSS в том же процессе. Тесты 3–4
 * in-jest, потому что assertions на поведение dedup / audit не зависят от
 * масштаба — там достаточно нескольких chunk-окон.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import {
  TwicImporter,
  DEFAULT_TWIC_IMPORT_CHUNK_SIZE,
  type ArchiveSourceRow,
} from './twic.importer';
import type { ArchivePositionWriterService } from '../archive-position-writer.service';
import type { PositionIndexerService } from '../position-indexer.service';
import type { ArchiveImportMetricsService } from '../archive-import-metrics.service';
import {
  generateTwicFixturePgn,
  generateTwicZipWithDuplicateAt,
} from '../../../test/fixtures/twic-synthetic';

// ─── Peak-RSS target (Fargate 512 MiB hard-limit, ADR-020 §2.5) ───────

const PEAK_RSS_TARGET_MIB = 400;

// ─── Вспомогалки child_process для 8k-профилей ────────────────────────

interface ProfileOutput {
  peakRssMiB: number;
  measurements: Array<{
    stage: string;
    rssMiB: number;
    heapUsedMiB: number;
    externalMiB: number;
  }>;
  runs: Array<{
    status: string;
    gamesParsed: number;
    gamesAdded: number;
    gamesSkipped: number;
    cursorBefore: string | null;
    cursorAfter: string | null;
    fileName: string | null;
  }>;
  db: {
    knownCount: number;
    importCreates: number;
    sourceUpdates: number;
    lastImportUpdate: {
      id: string;
      status: string;
      gamesParsed: number;
      gamesAdded: number;
      gamesSkipped: number;
      cursorAfter: string | null;
      finishedAt: string | null;
    } | null;
  };
  gcExposed: boolean;
}

const PROFILE_SCRIPT = path.resolve(
  __dirname,
  '../../../test/profile/profile-twic-importer.ts',
);

/**
 * Резолв tsx бинарника через upward-поиск по node_modules/.bin, начиная
 * от __dirname и поднимаясь до корня файловой системы. Это работает и в
 * рабочей копии на хосте, и в контейнере agent'а — не зависит от того,
 * где именно смонтирован workspace. `/project/node_modules/.bin/tsx`
 * оставлен как last-resort fallback для legacy container layouts.
 */
function resolveTsxBin(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const candidates: string[] = [];

  let dir = __dirname;
  // Upward lookup: node_modules/.bin/tsx на каждом уровне до корня ФС.
  while (true) {
    candidates.push(path.join(dir, 'node_modules', '.bin', 'tsx'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Legacy fallback (container with /project mount).
  if (!candidates.includes('/project/node_modules/.bin/tsx')) {
    candidates.push('/project/node_modules/.bin/tsx');
  }

  for (const bin of candidates) {
    try {
      if (fs.existsSync(bin)) return bin;
    } catch {
      // ignore
    }
  }
  throw new Error(
    `tsx binary not found (checked: ${candidates.join(', ')}). ` +
      'Install deps at monorepo root before running streaming spec.',
  );
}

function runProfile(args: string[], timeoutMs = 600_000): ProfileOutput {
  const result = spawnSync(resolveTsxBin(), [PROFILE_SCRIPT, ...args], {
    cwd: path.resolve(__dirname, '../../..'),
    env: { ...process.env, NODE_OPTIONS: '--expose-gc' },
    encoding: 'utf-8',
    timeout: timeoutMs,
    // Profile stdout — JSON, обычно 5-15 KiB. maxBuffer с запасом.
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `profile-twic-importer exited with status=${result.status}:\n` +
        `stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as ProfileOutput;
  } catch (err) {
    throw new Error(
      `Failed to parse profiler stdout as JSON: ${
        (err as Error).message
      }\nstdout: ${result.stdout.slice(0, 1000)}`,
    );
  }
}

// ─── In-jest fake Prisma / stubs (для тестов 3–4) ─────────────────────

type FakeArchiveSource = {
  id: string;
  code: string;
  cursor: string | null;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  totalGames: number;
};

type FakeImportRow = {
  id: string;
  sourceId: string;
  status: string;
  fileName: string | null;
  cursorBefore: string | null;
  cursorAfter: string | null;
  gamesParsed: number;
  gamesAdded: number;
  gamesSkipped: number;
  finishedAt: Date | null;
};

type FakeGameRow = {
  id: string;
  contentHashHex: string;
  isClassical: boolean;
};

interface FakeDbState {
  source: FakeArchiveSource;
  imports: FakeImportRow[];
  games: FakeGameRow[];
}

function freshState(): FakeDbState {
  return {
    source: {
      id: 'source-uuid',
      code: 'twic',
      cursor: '1641',
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: null,
      totalGames: 0,
    },
    imports: [],
    games: [],
  };
}

function fakePrisma(state: FakeDbState) {
  let importSeq = 0;
  let gameSeq = 0;

  const archiveImport = {
    create: jest.fn(async ({ data }: { data: Partial<FakeImportRow> }) => {
      importSeq += 1;
      const row: FakeImportRow = {
        id: `import-${importSeq}`,
        sourceId: data.sourceId ?? state.source.id,
        status: data.status ?? 'running',
        fileName: data.fileName ?? null,
        cursorBefore: data.cursorBefore ?? null,
        cursorAfter: null,
        gamesParsed: 0,
        gamesAdded: 0,
        gamesSkipped: 0,
        finishedAt: null,
      };
      state.imports.push(row);
      return row;
    }),
    update: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeImportRow>;
      }) => {
        const row = state.imports.find((r) => r.id === where.id);
        if (!row) throw new Error(`archive_imports not found: ${where.id}`);
        Object.assign(row, data);
        return row;
      },
    ),
  };

  const archiveGame = {
    findMany: jest.fn(
      async ({
        where,
      }: {
        where: { contentHash: { in: Uint8Array[] } };
      }) => {
        const known = new Set(state.games.map((g) => g.contentHashHex));
        return where.contentHash.in
          .filter((h) => known.has(Buffer.from(h).toString('hex')))
          .map((h) => ({ contentHash: Buffer.from(h) }));
      },
    ),
    create: jest.fn(
      async ({
        data,
      }: {
        data: { contentHash: Uint8Array; isClassical: boolean };
        select: { id: true };
      }) => {
        const hex = Buffer.from(data.contentHash).toString('hex');
        if (state.games.some((g) => g.contentHashHex === hex)) {
          const err = new Error(
            `UNIQUE violation on content_hash ${hex.slice(0, 8)}…`,
          ) as Error & { code?: string };
          err.code = 'P2002';
          throw err;
        }
        gameSeq += 1;
        const row: FakeGameRow = {
          id: `game-${gameSeq}`,
          contentHashHex: hex,
          isClassical: data.isClassical,
        };
        state.games.push(row);
        return { id: row.id };
      },
    ),
  };

  const archiveSource = {
    update: jest.fn(async () => state.source),
  };

  return { archiveImport, archiveGame, archiveSource };
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

function makeZipBuffer(pgnContent: string, fileName: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(fileName, Buffer.from(pgnContent, 'utf-8'));
  return zip.toBuffer();
}

// ─── Тесты 1, 2, 4 — через child_process profile ──────────────────────

describe('TwicImporter streaming pipeline — 8k fixture (child_process profile)', () => {
  // Профиль с `mode=idempotent repeat=2` проходит fixture дважды на одной
  // fake-Prisma: первый run добавляет 8000 новых, второй — все 8000 уже
  // известны → skipped=8000. Это даёт нам данные сразу для тестов 1, 2 и 4
  // из одного запуска (~20-30 сек), не тройным повтором child_process.
  let profile: ProfileOutput;

  beforeAll(() => {
    profile = runProfile([
      '8000',
      '--issue=9999',
      '--mode=idempotent',
      '--repeat=2',
    ]);
    // Для диагностики при падении тестов: peak sampler value + финальные
    // стадии попадают в stderr профилировщика; сам JSON парсится отдельно.
  }, 600_000);

  it('Тест 1 — peak RSS < 400 MiB на 8k fixture (ADR-020 §2.5 защитный якорь)', () => {
    expect(profile.gcExposed).toBe(true);
    expect(profile.peakRssMiB).toBeLessThan(PEAK_RSS_TARGET_MIB);

    // Первый прогон даёт полноценный parse + insert всех 8000 партий.
    expect(profile.runs[0]).toMatchObject({
      status: 'ok',
      gamesParsed: 8000,
      gamesAdded: 8000,
      gamesSkipped: 0,
    });
  });

  it('Тест 2 — dedup idempotency: повторный run → gamesAdded=0, gamesSkipped=8000', () => {
    expect(profile.runs).toHaveLength(2);

    // Второй прогон проходит по filterAlreadyImported и отбрасывает всё.
    expect(profile.runs[1]).toMatchObject({
      status: 'ok',
      gamesParsed: 8000,
      gamesAdded: 0,
      gamesSkipped: 8000,
      // ad-hoc-маркер: cursor не двигался.
      cursorBefore: '1641',
      cursorAfter: '1641',
    });

    // В fake-Prisma зафиксировано 8000 уникальных content_hash — второй
    // прогон не добавил новых и не дублировал.
    expect(profile.db.knownCount).toBe(8000);
    // archiveSource.update НЕ вызывался ни разу (runAdHoc-режим).
    expect(profile.db.sourceUpdates).toBe(0);
  });

  it('Тест 4 — aggregate audit row: archive_imports.create вызван ровно `repeats` раз (не N chunks)', () => {
    // 8000 / 500 chunk = 16 chunk'ов ПЕР run. С repeat=2 всего 32 chunk'а.
    // Если бы audit-row писался per chunk, мы бы увидели 32 create'а.
    // Контракт: ровно ОДНА строка archive_imports на run.
    expect(profile.db.importCreates).toBe(2);

    // Финальный update — status='ok', gamesParsed/Added/Skipped
    // соответствуют именно второму (последнему) run'у.
    expect(profile.db.lastImportUpdate).not.toBeNull();
    expect(profile.db.lastImportUpdate!).toMatchObject({
      status: 'ok',
      gamesParsed: 8000,
      gamesAdded: 0,
      gamesSkipped: 8000,
    });
    expect(profile.db.lastImportUpdate!.finishedAt).not.toBeNull();
  });
});

// ─── Тест 3 — chunk boundary UNIQUE (in-jest, меньший fixture) ────────

describe('TwicImporter streaming pipeline — chunk boundary UNIQUE (in-jest)', () => {
  const sourceRow: ArchiveSourceRow = {
    id: 'source-uuid',
    code: 'twic',
    cursor: '1641',
  };
  // chunk-boundary тест — строим CHUNK_SIZE+100 партий с дублем на границе
  // chunk'ов. При chunk_size=N: chunk #1 = idx [0..N-1], chunk #2 =
  // idx [N..N+99]. Оригинал под idx=N-1, копия под idx=N — т.е. первая
  // запись chunk'а #2 дублирует последнюю запись chunk'а #1.
  const CHUNK_SIZE = DEFAULT_TWIC_IMPORT_CHUNK_SIZE; // KS-1688: = 200
  const DUP_FIRST = CHUNK_SIZE - 1;
  const DUP_SECOND = CHUNK_SIZE;
  const TOTAL = CHUNK_SIZE + 100;

  // Детерминированно фиксируем chunk_size на DEFAULT, чтобы тесты не
  // зависели от TWIC_IMPORT_CHUNK_SIZE из окружения оператора/CI.
  const savedChunkEnv = process.env.TWIC_IMPORT_CHUNK_SIZE;
  beforeEach(() => {
    process.env.TWIC_IMPORT_CHUNK_SIZE = String(CHUNK_SIZE);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    restoreFetch();
    if (savedChunkEnv === undefined) {
      delete process.env.TWIC_IMPORT_CHUNK_SIZE;
    } else {
      process.env.TWIC_IMPORT_CHUNK_SIZE = savedChunkEnv;
    }
  });

  it('Тест 3 — дубли на границе chunk\'ов: вторая падает P2002, учтена в gamesSkipped', async () => {
    const state = freshState();
    const prisma = fakePrisma(state);

    const zipBuffer = generateTwicZipWithDuplicateAt(
      TOTAL,
      DUP_FIRST,
      DUP_SECOND,
      'twic9998.pgn',
    );
    stubFetch(zipBuffer);

    const importer = new TwicImporter(
      prisma as never,
      sourceRow,
      fakeWriter(),
      fakeIndexer(),
      fakeMetrics(),
    );

    const result = await importer.runAdHoc(9998);

    // parsed = 600 валидных партий (обе партии — оригинал и копия — парсятся).
    expect(result.gamesParsed).toBe(TOTAL);
    // Оригинал (idx=DUP_FIRST) вставлен в chunk #1. Копия (idx=DUP_SECOND)
    // попадает в chunk #2: filterAlreadyImported до начала chunk-loop'а
    // видит обе как «свежие» (на тот момент в БД ещё ничего не было),
    // поэтому обе идут в chunk-loop. chunk #1 вставляет оригинал, chunk #2
    // при попытке вставить копию ловит P2002 → skipped++.
    expect(result.gamesAdded).toBe(TOTAL - 1);
    expect(result.gamesSkipped).toBe(1);
    expect(result.status).toBe('ok');

    // В fake-state: 599 уникальных content_hash, audit-row ровно один.
    expect(state.games).toHaveLength(TOTAL - 1);
    expect(state.imports).toHaveLength(1);
    expect(state.imports[0]).toMatchObject({
      status: 'ok',
      gamesParsed: TOTAL,
      gamesAdded: TOTAL - 1,
      gamesSkipped: 1,
    });
  }, 60_000);

  it('Тест 4b — aggregate audit row на малом run (>1 chunk\'а) тоже ровно 1 строка', async () => {
    // Параллельная проверка теста 4 в-jest: 1500 партий при chunk_size=200
    // (KS-1688) → 8 chunk'ов. importCreates должен остаться === 1.
    const state = freshState();
    const prisma = fakePrisma(state);

    const pgnContent = generateTwicFixturePgn(1500);
    const zipBuffer = makeZipBuffer(pgnContent, 'twic9997.pgn');
    stubFetch(zipBuffer);

    const importer = new TwicImporter(
      prisma as never,
      sourceRow,
      fakeWriter(),
      fakeIndexer(),
      fakeMetrics(),
    );

    const result = await importer.runAdHoc(9997);

    expect(result.status).toBe('ok');
    expect(result.gamesParsed).toBe(1500);
    expect(result.gamesAdded).toBe(1500);
    // Ровно одна audit-row, а не 3 (по числу chunk'ов).
    expect(prisma.archiveImport.create).toHaveBeenCalledTimes(1);
    expect(state.imports).toHaveLength(1);
    expect(state.imports[0].gamesAdded).toBe(1500);
    expect(state.imports[0].finishedAt).toBeInstanceOf(Date);
  }, 60_000);
});
