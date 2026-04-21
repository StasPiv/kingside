/**
 * KS-1685 — якорные тесты для `TwicImporter.runAdHoc` (ad-hoc ветка).
 *
 * Фиксируют runtime-инварианты ADR-020 §2.4.3:
 *   1. Ad-hoc-импорт конкретного выпуска НЕ изменяет `archive_sources`
 *      (cursor, lastRunAt, lastSuccessAt, lastError, totalGames).
 *   2. Новая строка в `archive_imports` с `cursor_before === cursor_after`
 *      — знак что импорт курсор не двигал.
 *   3. Идемпотентность: повторный прогон того же выпуска даёт
 *      `gamesAdded=0`, `gamesSkipped=N`, ничего в `archive_games`
 *      не дублирует.
 *
 * Гейт «Redis PUBLISH вызывается только при `gamesAdded > 0`» проверяется
 * на уровне CLI в `apps/archive-service/src/cli/import-twic-issue.spec.ts`
 * (см. тесты «если games_added=0 → PUBLISH НЕ вызывается») — importer
 * сам Redis не трогает.
 */

import AdmZip from 'adm-zip';
import {
  TwicImporter,
  type ArchiveSourceRow,
  type ImportResult,
} from './twic.importer';
import { parseBatch } from '../pgn-utils';
import type { ArchivePositionWriterService } from '../archive-position-writer.service';
import type { PositionIndexerService } from '../position-indexer.service';
import type { ArchiveImportMetricsService } from '../archive-import-metrics.service';

// ─── Фикстуры ──────────────────────────────────────────────────────────

/**
 * Минимальная валидная PGN-партия. Без тега `TimeControl` / нестандартных
 * сайтов — `classifyGame` возвращает `classical-legacy` + `isClassical:true`,
 * что прогоняет путь через индексер и writer (иначе они пропускаются).
 */
function makePgn(
  white: string,
  black: string,
  round: string,
  moves: string,
): string {
  return [
    '[Event "Test Tournament"]',
    '[Site "Test City"]',
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

function makeZipBuffer(pgnContent: string, fileName: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(fileName, Buffer.from(pgnContent, 'utf-8'));
  return zip.toBuffer();
}

// ─── Мок Prisma с in-memory состоянием ─────────────────────────────────

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
  sourceId: string;
  importId: string;
  contentHash: Buffer;
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
      lastRunAt: new Date('2026-04-20T12:00:00Z'),
      lastSuccessAt: new Date('2026-04-20T12:00:00Z'),
      lastError: 'prev-error-marker',
      totalGames: 12345,
    },
    imports: [],
    games: [],
  };
}

function fakePrisma(state: FakeDbState) {
  let gameSeq = 0;
  let importSeq = 0;

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
        select: { contentHash: true };
      }) => {
        const known = new Set(
          state.games.map((g) => Buffer.from(g.contentHash).toString('hex')),
        );
        return where.contentHash.in
          .filter((h) => known.has(Buffer.from(h).toString('hex')))
          .map((h) => ({ contentHash: Buffer.from(h) }));
      },
    ),
    create: jest.fn(
      async ({
        data,
        select: _select,
      }: {
        data: { contentHash: Uint8Array; isClassical: boolean };
        select: { id: true };
      }) => {
        const hashHex = Buffer.from(data.contentHash).toString('hex');
        if (
          state.games.some(
            (g) => Buffer.from(g.contentHash).toString('hex') === hashHex,
          )
        ) {
          const err = new Error(
            `UNIQUE violation on content_hash ${hashHex.slice(0, 8)}…`,
          ) as Error & { code?: string };
          err.code = 'P2002';
          throw err;
        }
        gameSeq += 1;
        const row: FakeGameRow = {
          id: `game-${gameSeq}`,
          sourceId: state.source.id,
          importId: 'import-current',
          contentHash: Buffer.from(data.contentHash),
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

// ─── Стабы метрик / writer / indexer ───────────────────────────────────

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

// ─── Мок fetch: возвращает заданный zip-buffer ─────────────────────────

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

// ─── Сами тесты ────────────────────────────────────────────────────────

describe('TwicImporter.runAdHoc — ADR-020 §2.4.3 инварианты', () => {
  const sourceRow: ArchiveSourceRow = {
    id: 'source-uuid',
    code: 'twic',
    cursor: '1641',
  };

  // Три валидных PGN-партии. Каждая даёт уникальный content_hash
  // (разные round + разные ходы). Все классифицируются как
  // `classical-legacy` (нет TC, нейтральный Site) → isClassical=true.
  const pgnGame1 = makePgn('Alice', 'Bob', '1', '1. e4 e5 2. Nf3 Nc6');
  const pgnGame2 = makePgn('Carol', 'Dan', '2', '1. d4 d5 2. c4 e6');
  const pgnGame3 = makePgn('Eve', 'Frank', '3', '1. c4 c5 2. Nc3 Nc6');
  const pgnContent = [pgnGame1, pgnGame2, pgnGame3].join('\n\n');
  const fileName = 'twic1639.pgn';
  const zipBuffer = makeZipBuffer(pgnContent, fileName);

  afterEach(() => {
    jest.restoreAllMocks();
    restoreFetch();
  });

  it('Тест 1 — invariant: ad-hoc НЕ трогает archive_sources, пишет archive_imports с cursor_before=cursor_after', async () => {
    const state = freshState();
    const prisma = fakePrisma(state);

    // Пре-сидируем один из content_hash'ей, чтобы дедап отфильтровал одну
    // партию (M = N-1 = 2 новых).
    const { games: parsedPreview } = parseBatch(pgnContent);
    expect(parsedPreview).toHaveLength(3);
    state.games.push({
      id: 'pre-seeded',
      sourceId: state.source.id,
      importId: 'prev-import',
      contentHash: Buffer.from(parsedPreview[0].contentHash),
      isClassical: true,
    });

    const sourceSnapshot = { ...state.source };
    const preSeededGamesCount = state.games.length;

    stubFetch(zipBuffer);

    const importer = new TwicImporter(
      prisma as never,
      sourceRow,
      fakeWriter(),
      fakeIndexer(),
      fakeMetrics(),
    );

    const result: ImportResult = await importer.runAdHoc(1639);

    // 1. archive_sources.update НЕ вызывался вовсе → все поля источника
    //    остались идентичными снимку.
    expect(prisma.archiveSource.update).not.toHaveBeenCalled();
    expect(state.source).toEqual(sourceSnapshot);

    // 2. archive_imports: ровно одна новая строка с ad-hoc-маркером.
    expect(state.imports).toHaveLength(1);
    const importRow = state.imports[0];
    expect(importRow.fileName).toBe(fileName);
    expect(importRow.cursorBefore).toBe('1641');
    expect(importRow.cursorAfter).toBe('1641');
    expect(importRow.status).toBe('ok');
    expect(importRow.gamesParsed).toBe(3);
    expect(importRow.gamesAdded).toBe(2);
    expect(importRow.gamesSkipped).toBe(1);
    expect(importRow.finishedAt).toBeInstanceOf(Date);

    // 3. archive_games: +2 новых поверх пре-сида (итого 3).
    expect(state.games).toHaveLength(preSeededGamesCount + 2);

    // 4. Возвращаемый ImportResult.
    expect(result).toMatchObject({
      status: 'ok',
      cursorBefore: '1641',
      cursorAfter: '1641',
      fileName,
      gamesParsed: 3,
      gamesAdded: 2,
      gamesSkipped: 1,
    });
    // classicalRatio = 2/2 = 1 (обе добавленные классические).
    expect(result.classicalRatio).toBeCloseTo(1);
  });

  it('Тест 2 — idempotency: повторный runAdHoc с тем же выпуском даёт gamesAdded=0, archive_sources остаётся неизменным', async () => {
    const state = freshState();
    const prisma = fakePrisma(state);
    const sourceSnapshot = { ...state.source };

    stubFetch(zipBuffer);

    const importer = new TwicImporter(
      prisma as never,
      sourceRow,
      fakeWriter(),
      fakeIndexer(),
      fakeMetrics(),
    );

    // Первый прогон: все 3 партии свежие.
    const first = await importer.runAdHoc(1639);
    expect(first.status).toBe('ok');
    expect(first.gamesAdded).toBe(3);
    expect(first.gamesSkipped).toBe(0);
    expect(state.games).toHaveLength(3);
    expect(state.imports).toHaveLength(1);

    // Второй прогон с тем же zip.
    const second = await importer.runAdHoc(1639);

    // 1. ImportResult.
    expect(second).toMatchObject({
      status: 'ok',
      cursorBefore: '1641',
      cursorAfter: '1641',
      fileName,
      gamesParsed: 3,
      gamesAdded: 0,
      gamesSkipped: 3,
    });

    // 2. archive_sources не тронут ни одним из двух вызовов.
    expect(prisma.archiveSource.update).not.toHaveBeenCalled();
    expect(state.source).toEqual(sourceSnapshot);

    // 3. В archive_imports две строки (каждый запуск аудитится).
    expect(state.imports).toHaveLength(2);
    expect(state.imports[1].cursorBefore).toBe('1641');
    expect(state.imports[1].cursorAfter).toBe('1641');
    expect(state.imports[1].gamesAdded).toBe(0);
    expect(state.imports[1].gamesSkipped).toBe(3);

    // 4. archive_games не вырос — те же 3 партии.
    expect(state.games).toHaveLength(3);

    // 5. На втором прогоне classicalRatio отсутствует (нечего добавлять).
    expect(second.classicalRatio).toBeUndefined();
  });
});
