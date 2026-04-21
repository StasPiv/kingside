import 'reflect-metadata';
import { Logger, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ImporterOnceModule } from './importer-once.module';
import { ArchiveImportService } from './archive-import/archive-import.service';
import { EmfMetricsPublisher } from './archive-import/emf-metrics.service';

/**
 * One-shot entrypoint для EventBridge Scheduler + ECS RunTask (KS-1681,
 * ADR-020 §0).
 *
 * Процесс:
 *   1. `IMPORTER_ONE_SHOT=1` ставится сразу, чтобы `ArchiveImportService`
 *      пропустил initial tick в onModuleInit (иначе tick() и tickOnce()
 *      запустились бы параллельно).
 *   2. Поднимается минимальный DI через `createApplicationContext`
 *      (PrismaModule, RedisModule, MetricsModule, ArchiveImportModule,
 *      EmfMetricsPublisher). HTTP НЕ поднимается.
 *   3. Глобальный timeout 8 минут (hard) — `process.exit(124)` на случай
 *      зависшей fetch-зависимости (TWIC HTTP, Redis, Postgres). ECS
 *      RunTask-таска не должна жить дольше запланированного окна.
 *   4. `ArchiveImportService.tickOnce()` — один проход по всем enabled-
 *      источникам, детальный результат.
 *   5. `EmfMetricsPublisher.recordSourceRun(...)` + `recordTickSummary(...)`
 *      + `await flush()` — публикует CloudWatch EMF до exit.
 *   6. `process.exit(code)`:
 *      - 0  → успех (включая no-op: source not due);
 *      - 1  → bootstrap/теоретический throw до вызова tickOnce;
 *      - 2  → tickOnce отработал, но хотя бы один run зафейлился
 *             (или throw'нул) — EventBridge/CloudWatch увидит non-zero
 *             exit, Alarm по SourcesFailed сработает;
 *      - 124 → глобальный timeout.
 *
 * Запуск локально:
 *   cd apps/archive-service
 *   ARCHIVE_DATABASE_URL=postgresql://... REDIS_HOST=localhost \
 *     node dist/importer-once.js
 */

const GLOBAL_TIMEOUT_MS = 8 * 60 * 1000;
const EXIT_TIMEOUT_CODE = 124;
const EXIT_RUN_FAILED_CODE = 2;
const EXIT_BOOTSTRAP_CODE = 1;

export interface RunOutcome {
  exitCode: number;
  runsTotal: number;
  runsFailed: number;
  totalGamesAdded: number;
}

/**
 * Основная оркестрация — экспортируется для тестов
 * (`importer-once.spec.ts`), которые подставляют мок-контекст и
 * проверяют, что EMF flush вызывается до возврата.
 */
export async function runImporterOnce(
  app: INestApplicationContext,
  logger: Logger = new Logger('ImporterOnce'),
): Promise<RunOutcome> {
  const archiveImport = app.get(ArchiveImportService);
  const emf = app.get(EmfMetricsPublisher);

  let tick: Awaited<ReturnType<ArchiveImportService['tickOnce']>>;
  try {
    tick = await archiveImport.tickOnce();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`tickOnce failed: ${msg}`);
    // Даже при throw в tickOnce — публикуем summary (пустой) и отдаём
    // EMF, чтобы CloudWatch alarm видел событие.
    emf.recordTickSummary({ runs: [], totalGamesAdded: 0 });
    await emf.flush();
    return { exitCode: EXIT_RUN_FAILED_CODE, runsTotal: 0, runsFailed: 1, totalGamesAdded: 0 };
  }

  const now = new Date();
  for (const run of tick.runs) {
    emf.recordSourceRun(run, now);
  }
  emf.recordTickSummary(tick);
  await emf.flush();

  const runsFailed = tick.runs.filter(
    (r) => r.error != null || r.result?.status === 'failed',
  ).length;
  const exitCode = runsFailed > 0 ? EXIT_RUN_FAILED_CODE : 0;

  logger.log(
    `tickOnce done: runs=${tick.runs.length} failed=${runsFailed} ` +
      `gamesAdded=${tick.totalGamesAdded} exit=${exitCode}`,
  );
  return {
    exitCode,
    runsTotal: tick.runs.length,
    runsFailed,
    totalGamesAdded: tick.totalGamesAdded,
  };
}

async function bootstrap(): Promise<number> {
  // Критично: флаг должен быть выставлен ДО createApplicationContext,
  // чтобы ArchiveImportService.onModuleInit увидел его и пропустил
  // initial tick. Иначе двойной tick гарантирует пустой результат.
  process.env.IMPORTER_ONE_SHOT = '1';

  const logger = new Logger('ImporterOnce');

  // Hard timeout — на случай зависшей fetch()/Redis-зависимости.
  const timeoutHandle = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error(
      `[importer-once] global timeout ${GLOBAL_TIMEOUT_MS}ms reached — killing process`,
    );
    process.exit(EXIT_TIMEOUT_CODE);
  }, GLOBAL_TIMEOUT_MS);
  // unref: сам по себе таймер не держит process alive — если tickOnce
  // завершится раньше, exit произойдёт штатно.
  timeoutHandle.unref();

  let app: INestApplicationContext | null = null;
  try {
    app = await NestFactory.createApplicationContext(ImporterOnceModule, {
      // Явный logger — иначе Nest использует свой дефолт, stdout замусорится
      // JSON'ом EMF и plain-логами в одном формате. Оставляем дефолт Nest
      // (Logger из @nestjs/common) — EMF пишет однострочный JSON, Nest
      // человекочитаемый; CloudWatch Logs Insights разберёт оба.
    });

    const outcome = await runImporterOnce(app, logger);
    return outcome.exitCode;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`bootstrap/tickOnce fatal: ${msg}`);
    return EXIT_BOOTSTRAP_CODE;
  } finally {
    if (app) {
      try {
        await app.close();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`app.close error: ${msg}`);
      }
    }
    clearTimeout(timeoutHandle);
  }
}

// Только при прямом запуске `node dist/importer-once.js`. Импорт из тестов
// не запускает bootstrap — тесты вызывают `runImporterOnce(app)` напрямую.
if (require.main === module) {
  bootstrap()
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[importer-once] Unhandled:', err);
      process.exit(EXIT_BOOTSTRAP_CODE);
    });
}
