import type { INestApplicationContext } from '@nestjs/common';
import { runImporterOnce } from './importer-once';
import {
  ArchiveImportService,
  TickTimeoutError,
} from './archive-import/archive-import.service';
import { EmfMetricsPublisher } from './archive-import/emf-metrics.service';
import { ArchiveSourcesSeedService } from './archive-import/archive-sources-seed.service';
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
  | { kind: 'run'; run: TickSourceResult }
  | { kind: 'summary'; tick: TickResult; exitCode: number }
  | { kind: 'flush' };

interface MockContext {
  archive: {
    tickOnce: jest.Mock<Promise<TickResult>, []>;
  };
  emf: {
    recordSourceRun: jest.Mock;
    recordTickSummary: jest.Mock;
    flush: jest.Mock<Promise<void>, []>;
    calls: EmfCall[];
  };
  seed: {
    ensureDefaults: jest.Mock<
      Promise<{ created: number; kept: number }>,
      []
    >;
  };
  app: INestApplicationContext;
}

function makeContext(tick: TickResult | Error): MockContext {
  const emfCalls: EmfCall[] = [];

  const archive = {
    tickOnce: jest.fn<Promise<TickResult>, []>(() => {
      if (tick instanceof Error) return Promise.reject(tick);
      return Promise.resolve(tick);
    }),
  };
  const emf = {
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
      Promise<{ created: number; kept: number }>,
      []
    >(() => Promise.resolve({ created: 0, kept: 1 })),
  };

  const app: INestApplicationContext = {
    get: jest.fn((token: unknown) => {
      if (token === ArchiveImportService) return archive;
      if (token === EmfMetricsPublisher) return emf;
      if (token === ArchiveSourcesSeedService) return seed;
      throw new Error(`unexpected token: ${String(token)}`);
    }),
    // Остальные методы INestApplicationContext не нужны для этих тестов.
  } as unknown as INestApplicationContext;

  return { archive, emf, seed, app };
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

    // Порядок: recordSourceRun → recordTickSummary → flush.
    const kinds = ctx.emf.calls.map((c) => c.kind);
    expect(kinds).toEqual(['run', 'summary', 'flush']);

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
      return Promise.resolve({ created: 1, kept: 0 });
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
