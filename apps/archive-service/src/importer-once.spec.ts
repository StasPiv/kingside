import type { INestApplicationContext } from '@nestjs/common';
import { runImporterOnce } from './importer-once';
import {
  ArchiveImportService,
  TickTimeoutError,
} from './archive-import/archive-import.service';
import {
  EmfMetricsPublisher,
  type ArchiveSourceCatalogEntry,
} from './archive-import/emf-metrics.service';
import { ArchiveSourcesSeedService } from './archive-import/archive-sources-seed.service';
import { PrismaService } from './prisma/prisma.service';
import type {
  TickResult,
  TickSourceResult,
} from './archive-import/archive-import.service';

/**
 * Тесты для orchestration-функции `runImporterOnce(app)`.
 *
 * Не проверяем bootstrap (NestFactory.createApplicationContext) и
 * process.exit — они дергают реальный процесс/DI. Вместо этого собираем
 * мок-контекст, куда `app.get(Token)` возвращает подготовленные моки
 * ArchiveImportService и EmfMetricsPublisher, и проверяем порядок
 * вызовов: recordSourceRun → recordTickSummary → flush, а также что
 * exit-код рассчитан корректно.
 */

type EmfCall =
  | { kind: 'catalog'; entries: ReadonlyArray<ArchiveSourceCatalogEntry> }
  | { kind: 'run'; run: TickSourceResult }
  | { kind: 'summary'; tick: TickResult; exitCode: number }
  | { kind: 'flush' };

type CatalogRow = { code: string; enabled: boolean; lastSuccessAt: Date | null };

interface MockContext {
  archive: {
    tickOnce: jest.Mock<Promise<TickResult>, []>;
  };
  emf: {
    recordCatalogAge: jest.Mock;
    recordSourceRun: jest.Mock;
    recordTickSummary: jest.Mock;
    flush: jest.Mock<Promise<void>, []>;
    calls: EmfCall[];
  };
  seed: {
    ensureDefaults: jest.Mock<
      Promise<{ created: number; kept: number; healed: number }>,
      []
    >;
  };
  prisma: {
    archiveSource: {
      findMany: jest.Mock<Promise<CatalogRow[]>, [unknown]>;
    };
  };
  app: INestApplicationContext;
}

interface MakeContextOptions {
  catalog?: CatalogRow[] | Error;
}

function makeContext(
  tick: TickResult | Error,
  options: MakeContextOptions = {},
): MockContext {
  const emfCalls: EmfCall[] = [];

  const archive = {
    tickOnce: jest.fn<Promise<TickResult>, []>(() => {
      if (tick instanceof Error) return Promise.reject(tick);
      return Promise.resolve(tick);
    }),
  };
  const emf = {
    recordCatalogAge: jest.fn(
      (entries: ReadonlyArray<ArchiveSourceCatalogEntry>) => {
        emfCalls.push({ kind: 'catalog', entries });
      },
    ),
    recordSourceRun: jest.fn((run: TickSourceResult) => {
      emfCalls.push({ kind: 'run', run });
    }),
    recordTickSummary: jest.fn((t: TickResult, exitCode: number = 0) => {
      emfCalls.push({ kind: 'summary', tick: t, exitCode });
    }),
    flush: jest.fn<Promise<void>, []>(() => {
      emfCalls.push({ kind: 'flush' });
      return Promise.resolve();
    }),
    calls: emfCalls,
  };
  const seed = {
    ensureDefaults: jest.fn<
      Promise<{ created: number; kept: number; healed: number }>,
      []
    >(() => Promise.resolve({ created: 0, kept: 1, healed: 0 })),
  };

  const catalogDefault: CatalogRow[] = [
    { code: 'twic', enabled: true, lastSuccessAt: null },
  ];
  const catalogResponse = options.catalog ?? catalogDefault;
  const prisma = {
    archiveSource: {
      findMany: jest.fn<Promise<CatalogRow[]>, [unknown]>((args: unknown) => {
        if (catalogResponse instanceof Error) {
          return Promise.reject(catalogResponse);
        }
        // KS-4313: post-tick fetch фильтрует enabled=true в БД через
        // `where: { enabled: true }`. Эмулируем это в моке, чтобы тесты
        // покрывали реальное поведение Prisma.
        const where = (args as { where?: { enabled?: boolean } } | undefined)
          ?.where;
        if (where?.enabled === true) {
          return Promise.resolve(catalogResponse.filter((r) => r.enabled));
        }
        return Promise.resolve(catalogResponse);
      }),
    },
  };

  const app: INestApplicationContext = {
    get: jest.fn((token: unknown) => {
      if (token === ArchiveImportService) return archive;
      if (token === EmfMetricsPublisher) return emf;
      if (token === ArchiveSourcesSeedService) return seed;
      if (token === PrismaService) return prisma;
      throw new Error(`unexpected token: ${String(token)}`);
    }),
    // Остальные методы INestApplicationContext не нужны для этих тестов.
  } as unknown as INestApplicationContext;

  return { archive, emf, seed, prisma, app };
}

function makeRun(overrides: Partial<TickSourceResult> = {}): TickSourceResult {
  return {
    sourceCode: 'twic',
    due: true,
    lockHeld: false,
    result: {
      status: 'ok',
      cursorBefore: '1500',
      cursorAfter: '1501',
      fileName: 'twic1501.pgn',
      gamesParsed: 100,
      gamesAdded: 95,
      gamesSkipped: 5,
      classicalRatio: 0.84,
    },
    durationSec: 10,
    lastSuccessAt: new Date('2026-04-20T00:00:00Z'),
    ...overrides,
  };
}

describe('runImporterOnce', () => {
  it('happy path: source due, importer.run() succeeded → exitCode=0, EMF flushed, summary получил exitCode=0', async () => {
    const tick: TickResult = {
      runs: [makeRun()],
      totalGamesAdded: 95,
    };
    const ctx = makeContext(tick);
    const outcome = await runImporterOnce(ctx.app);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.runsTotal).toBe(1);
    expect(outcome.runsFailed).toBe(0);
    expect(outcome.totalGamesAdded).toBe(95);
    expect(outcome.timedOut).toBe(false);

    // Порядок: recordCatalogAge → recordSourceRun → recordTickSummary → flush
    // (catalog-emit идёт первым — он не зависит от tick.runs, см. KS-1716).
    const kinds = ctx.emf.calls.map((c) => c.kind);
    expect(kinds).toEqual(['catalog', 'run', 'summary', 'flush']);

    // recordTickSummary должен получить exitCode=0.
    const summaryCall = ctx.emf.calls.find((c) => c.kind === 'summary');
    expect(summaryCall).toBeDefined();
    if (summaryCall?.kind === 'summary') {
      expect(summaryCall.exitCode).toBe(0);
    }
  });

  it('no-op: source not due → runs=[{due:false,...}], exitCode=0, EMF всё равно записан', async () => {
    const tick: TickResult = {
      runs: [makeRun({ due: false, result: null, durationSec: 0 })],
      totalGamesAdded: 0,
    };
    const ctx = makeContext(tick);
    const outcome = await runImporterOnce(ctx.app);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.runsFailed).toBe(0);
    expect(ctx.emf.recordSourceRun).toHaveBeenCalledTimes(1);
    expect(ctx.emf.recordTickSummary).toHaveBeenCalledTimes(1);
    expect(ctx.emf.flush).toHaveBeenCalledTimes(1);
    expect(ctx.emf.recordTickSummary).toHaveBeenCalledWith(tick, 0);
  });

  it('failure: run.error установлен → exitCode=2, summary получил exitCode=2', async () => {
    const tick: TickResult = {
      runs: [makeRun({ result: null, error: 'redis down' })],
      totalGamesAdded: 0,
    };
    const ctx = makeContext(tick);
    const outcome = await runImporterOnce(ctx.app);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.runsFailed).toBe(1);
    expect(ctx.emf.flush).toHaveBeenCalled();
    expect(ctx.emf.recordTickSummary).toHaveBeenCalledWith(tick, 2);
  });

  it('failure: ImportResult.status=failed → exitCode=2', async () => {
    const tick: TickResult = {
      runs: [
        makeRun({
          result: {
            status: 'failed',
            cursorBefore: '1500',
            cursorAfter: '1500',
            fileName: null,
            gamesParsed: 0,
            gamesAdded: 0,
            gamesSkipped: 0,
            error: 'HTTP 500',
          },
        }),
      ],
      totalGamesAdded: 0,
    };
    const ctx = makeContext(tick);
    const outcome = await runImporterOnce(ctx.app);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.runsFailed).toBe(1);
  });

  it('смешанный результат: ok + failed → exitCode=2', async () => {
    const tick: TickResult = {
      runs: [
        makeRun({ sourceCode: 'twic' }),
        makeRun({ sourceCode: 'other', error: 'boom', result: null }),
      ],
      totalGamesAdded: 95,
    };
    const ctx = makeContext(tick);
    const outcome = await runImporterOnce(ctx.app);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.runsTotal).toBe(2);
    expect(outcome.runsFailed).toBe(1);
    expect(ctx.emf.recordSourceRun).toHaveBeenCalledTimes(2);
  });

  it('tickOnce throw (не-timeout) → exitCode=2, EMF summary+flush всё равно вызван с пустым tick и exitCode=2', async () => {
    const ctx = makeContext(new Error('DB unreachable'));
    const outcome = await runImporterOnce(ctx.app);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.runsTotal).toBe(0);
    expect(outcome.runsFailed).toBe(1);
    expect(outcome.timedOut).toBe(false);
    // recordSourceRun не должен был быть вызван (нет runs), но
    // recordTickSummary и flush — обязательно.
    expect(ctx.emf.recordSourceRun).not.toHaveBeenCalled();
    expect(ctx.emf.recordTickSummary).toHaveBeenCalledTimes(1);
    expect(ctx.emf.flush).toHaveBeenCalledTimes(1);
    expect(ctx.emf.recordTickSummary).toHaveBeenCalledWith(
      { runs: [], totalGamesAdded: 0 },
      2,
    );
  });

  it('TickTimeoutError → exitCode=124, partial runs публикуются, summary получает exitCode=124', async () => {
    const partial: TickResult = {
      runs: [makeRun({ sourceCode: 'twic' })],
      totalGamesAdded: 95,
    };
    const ctx = makeContext(
      new TickTimeoutError('tickOnce exceeded 480000ms; partial runs=1', partial),
    );
    const outcome = await runImporterOnce(ctx.app);

    expect(outcome.exitCode).toBe(124);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.runsTotal).toBe(1); // partial run опубликован
    expect(outcome.totalGamesAdded).toBe(95);

    // EMF должен получить per-source по partial.runs + summary с exitCode=124 + flush
    expect(ctx.emf.recordSourceRun).toHaveBeenCalledTimes(1);
    expect(ctx.emf.recordTickSummary).toHaveBeenCalledWith(partial, 124);
    expect(ctx.emf.flush).toHaveBeenCalled();
  });

  it('KS-1716: ensureDefaults() вызывается ДО tickOnce() — sources сидируются перед проверкой due', async () => {
    const tick: TickResult = {
      runs: [makeRun()],
      totalGamesAdded: 95,
    };
    const ctx = makeContext(tick);
    // Фиксируем порядок вызовов между двумя моками.
    const callOrder: Array<'seed' | 'tick'> = [];
    ctx.seed.ensureDefaults.mockImplementation(() => {
      callOrder.push('seed');
      return Promise.resolve({ created: 1, kept: 0, healed: 0 });
    });
    ctx.archive.tickOnce.mockImplementation(() => {
      callOrder.push('tick');
      return Promise.resolve(tick);
    });

    await runImporterOnce(ctx.app);

    expect(ctx.seed.ensureDefaults).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['seed', 'tick']);
  });

  it('KS-1716: ensureDefaults() throws → классифицируется как bootstrap fail, exitCode=2, EMF summary всё равно публикуется', async () => {
    const ctx = makeContext({ runs: [], totalGamesAdded: 0 });
    ctx.seed.ensureDefaults.mockRejectedValue(new Error('DB unreachable'));

    const outcome = await runImporterOnce(ctx.app);

    // ensureDefaults упал до tickOnce — tickOnce НЕ должен вызываться.
    expect(ctx.archive.tickOnce).not.toHaveBeenCalled();
    expect(outcome.exitCode).toBe(2);
    expect(outcome.runsTotal).toBe(0);
    expect(outcome.runsFailed).toBe(1);
    // Summary с exitCode=2 и пустым tick всё равно публикуется.
    expect(ctx.emf.recordTickSummary).toHaveBeenCalledWith(
      { runs: [], totalGamesAdded: 0 },
      2,
    );
    expect(ctx.emf.flush).toHaveBeenCalledTimes(1);
  });

  it('KS-1716: 1 enabled source в БД, не-due tick → runs пусты, recordCatalogAge получает TWIC → EMF содержит LastSuccessAgeSeconds{source=twic}', async () => {
    // Базовый сценарий, который пропустили в первом коммите KS-1716:
    // на не-due день (cron 0 */168 * * *) processAll возвращает runs=[]
    // (источников нет в findMany для enabled=true? нет — в реальности isDue
    // фильтрует в tickOnce, но здесь мы моделируем итог: tick.runs=[]).
    // catalog-emit должен сработать независимо и опубликовать
    // LastSuccessAgeSeconds{source=twic}, иначе alarm A4 остаётся в ALARM.
    const emptyTick: TickResult = { runs: [], totalGamesAdded: 0 };
    const lastSuccessAt = new Date('2026-04-01T00:00:00Z');
    const ctx = makeContext(emptyTick, {
      catalog: [{ code: 'twic', enabled: true, lastSuccessAt }],
    });
    const outcome = await runImporterOnce(ctx.app);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.runsTotal).toBe(0);
    expect(outcome.runsFailed).toBe(0);

    // KS-4313: findMany вызывается дважды.
    //   1) pre-tick — select code+enabled только для логирования
    //      total/enabled (lastSuccessAt не нужен — снимок устареет
    //      ещё до конца tickOnce).
    //   2) post-tick — `where: { enabled: true }` + select code+lastSuccessAt
    //      → свежий снимок для `recordCatalogAge`.
    expect(ctx.prisma.archiveSource.findMany).toHaveBeenCalledTimes(2);
    expect(ctx.prisma.archiveSource.findMany).toHaveBeenNthCalledWith(1, {
      select: { code: true, enabled: true },
    });
    expect(ctx.prisma.archiveSource.findMany).toHaveBeenNthCalledWith(2, {
      where: { enabled: true },
      select: { code: true, lastSuccessAt: true },
    });

    // EMF catalog-emit содержит ровно 1 источник — TWIC с lastSuccessAt.
    expect(ctx.emf.recordCatalogAge).toHaveBeenCalledTimes(1);
    const catalogCall = ctx.emf.calls.find((c) => c.kind === 'catalog');
    expect(catalogCall).toBeDefined();
    if (catalogCall?.kind === 'catalog') {
      expect(catalogCall.entries).toEqual([
        { code: 'twic', lastSuccessAt },
      ]);
    }

    // recordSourceRun НЕ вызывается, т.к. tick.runs пуст (не-due).
    expect(ctx.emf.recordSourceRun).not.toHaveBeenCalled();
    // tick-summary и flush — как обычно.
    expect(ctx.emf.recordTickSummary).toHaveBeenCalledWith(emptyTick, 0);
    expect(ctx.emf.flush).toHaveBeenCalledTimes(1);

    // Порядок: catalog → summary → flush (run нет).
    const kinds = ctx.emf.calls.map((c) => c.kind);
    expect(kinds).toEqual(['catalog', 'summary', 'flush']);
  });

  it('KS-1716 iter4: запись есть в БД, но enabled=false → catalog-emit фильтрует её, recordCatalogAge([]) пустой', async () => {
    // Реальный прод-сценарий после итерации 3: seed.ensureDefaults
    // отрапортовал kept=1 (запись TWIC в БД), но enabled=false (от
    // предыдущей версии кода). findMany без where теперь видит запись,
    // логирует total=1 enabled=0, фильтр даёт пустой catalog. На ЭТОМ
    // tick'е catalog-metric пустой — но heal-up в ensureDefaults
    // (archive-sources-seed.service) при СЛЕДУЮЩЕМ invocation'е
    // выставит enabled=true, и catalog-emit пойдёт штатно.
    const emptyTick: TickResult = { runs: [], totalGamesAdded: 0 };
    const ctx = makeContext(emptyTick, {
      catalog: [
        { code: 'twic', enabled: false, lastSuccessAt: null },
      ],
    });
    await runImporterOnce(ctx.app);

    expect(ctx.emf.recordCatalogAge).toHaveBeenCalledTimes(1);
    const catalogCall = ctx.emf.calls.find((c) => c.kind === 'catalog');
    if (catalogCall?.kind === 'catalog') {
      // enabled=false отфильтрован — catalog-emit пустой.
      expect(catalogCall.entries).toEqual([]);
    }
  });

  it('KS-1716: catalog fetch падает → recordCatalogAge([]) вызван, но tickOnce всё равно запускается', async () => {
    const tick: TickResult = { runs: [makeRun()], totalGamesAdded: 95 };
    const ctx = makeContext(tick, {
      catalog: new Error('prisma unreachable'),
    });
    const outcome = await runImporterOnce(ctx.app);

    // Catalog fetch fail — не bootstrap-ошибка, tickOnce всё равно выполняется.
    expect(ctx.archive.tickOnce).toHaveBeenCalledTimes(1);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.runsTotal).toBe(1);

    // recordCatalogAge вызывается с пустым массивом — ничего не
    // опубликуется, alarm A4 не получит datapoint на этом tick'е.
    expect(ctx.emf.recordCatalogAge).toHaveBeenCalledTimes(1);
    const catalogCall = ctx.emf.calls.find((c) => c.kind === 'catalog');
    if (catalogCall?.kind === 'catalog') {
      expect(catalogCall.entries).toEqual([]);
    }
  });

  it('KS-1716/KS-4313: ensureDefaults() throws → pre-tick fetch пропускается, post-tick fetch всё равно делается, recordCatalogAge с актуальным каталогом', async () => {
    // Catalog по умолчанию — один enabled-источник TWIC.
    const lastSuccessAt = new Date('2026-04-01T00:00:00Z');
    const ctx = makeContext(
      { runs: [], totalGamesAdded: 0 },
      { catalog: [{ code: 'twic', enabled: true, lastSuccessAt }] },
    );
    ctx.seed.ensureDefaults.mockRejectedValue(new Error('DB unreachable'));

    await runImporterOnce(ctx.app);

    // Pre-tick fetch (внутри outer try) пропускается вместе с tickOnce.
    // Post-tick fetch выполняется в отдельном try/catch и публикует
    // свежий каталог — это даёт мониторингу шанс показать актуальные
    // `LastSuccessAgeSeconds` даже при сбое orchestration'а.
    expect(ctx.prisma.archiveSource.findMany).toHaveBeenCalledTimes(1);
    expect(ctx.prisma.archiveSource.findMany).toHaveBeenCalledWith({
      where: { enabled: true },
      select: { code: true, lastSuccessAt: true },
    });
    expect(ctx.emf.recordCatalogAge).toHaveBeenCalledWith(
      [{ code: 'twic', lastSuccessAt }],
      expect.any(Date),
    );
    expect(ctx.emf.flush).toHaveBeenCalledTimes(1);
  });

  it('partial status — не считается failure, exitCode=0', async () => {
    const tick: TickResult = {
      runs: [
        makeRun({
          result: {
            status: 'partial',
            cursorBefore: '1500',
            cursorAfter: '1501',
            fileName: 'twic1501.pgn',
            gamesParsed: 100,
            gamesAdded: 90,
            gamesSkipped: 10,
            classicalRatio: 0.8,
          },
        }),
      ],
      totalGamesAdded: 90,
    };
    const ctx = makeContext(tick);
    const outcome = await runImporterOnce(ctx.app);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.runsFailed).toBe(0);
  });
});
