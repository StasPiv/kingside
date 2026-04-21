import type { INestApplicationContext } from '@nestjs/common';
import { runImporterOnce } from './importer-once';
import { ArchiveImportService } from './archive-import/archive-import.service';
import { EmfMetricsPublisher } from './archive-import/emf-metrics.service';
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

interface MockContext {
  archive: {
    tickOnce: jest.Mock<Promise<TickResult>, []>;
  };
  emf: {
    recordSourceRun: jest.Mock;
    recordTickSummary: jest.Mock;
    flush: jest.Mock<Promise<void>, []>;
    calls: Array<{ kind: 'run'; run: TickSourceResult } | { kind: 'summary' } | { kind: 'flush' }>;
  };
  app: INestApplicationContext;
}

function makeContext(tick: TickResult | Error): MockContext {
  const emfCalls: MockContext['emf']['calls'] = [];

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
    recordTickSummary: jest.fn(() => {
      emfCalls.push({ kind: 'summary' });
    }),
    flush: jest.fn<Promise<void>, []>(() => {
      emfCalls.push({ kind: 'flush' });
      return Promise.resolve();
    }),
    calls: emfCalls,
  };

  const app: INestApplicationContext = {
    get: jest.fn((token: unknown) => {
      if (token === ArchiveImportService) return archive;
      if (token === EmfMetricsPublisher) return emf;
      throw new Error(`unexpected token: ${String(token)}`);
    }),
    // Остальные методы INestApplicationContext не нужны для этих тестов.
  } as unknown as INestApplicationContext;

  return { archive, emf, app };
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
    },
    durationSec: 10,
    lastSuccessAt: new Date('2026-04-20T00:00:00Z'),
    ...overrides,
  };
}

describe('runImporterOnce', () => {
  it('happy path: source due, importer.run() succeeded → exitCode=0, EMF flushed', async () => {
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

    // Порядок: recordSourceRun → recordTickSummary → flush.
    const kinds = ctx.emf.calls.map((c) => c.kind);
    expect(kinds).toEqual(['run', 'summary', 'flush']);
  });

  it('no-op: source not due → runs=[{due:false,...}], exitCode=0, EMF всё равно записан', async () => {
    const tick: TickResult = {
      runs: [
        makeRun({ due: false, result: null, durationSec: 0 }),
      ],
      totalGamesAdded: 0,
    };
    const ctx = makeContext(tick);
    const outcome = await runImporterOnce(ctx.app);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.runsFailed).toBe(0);
    expect(ctx.emf.recordSourceRun).toHaveBeenCalledTimes(1);
    expect(ctx.emf.recordTickSummary).toHaveBeenCalledTimes(1);
    expect(ctx.emf.flush).toHaveBeenCalledTimes(1);
  });

  it('failure: run.error установлен → exitCode=2', async () => {
    const tick: TickResult = {
      runs: [
        makeRun({ result: null, error: 'redis down' }),
      ],
      totalGamesAdded: 0,
    };
    const ctx = makeContext(tick);
    const outcome = await runImporterOnce(ctx.app);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.runsFailed).toBe(1);
    expect(ctx.emf.flush).toHaveBeenCalled();
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

  it('tickOnce throw → exitCode=2, EMF summary+flush всё равно вызван', async () => {
    const ctx = makeContext(new Error('DB unreachable'));
    const outcome = await runImporterOnce(ctx.app);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.runsTotal).toBe(0);
    expect(outcome.runsFailed).toBe(1);
    // recordSourceRun не должен был быть вызван (нет runs), но
    // recordTickSummary и flush — обязательно.
    expect(ctx.emf.recordSourceRun).not.toHaveBeenCalled();
    expect(ctx.emf.recordTickSummary).toHaveBeenCalledTimes(1);
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
