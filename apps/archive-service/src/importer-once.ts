import 'reflect-metadata';
// КРИТИЧНО: импортируется side-effect-ом ДО `./importer-once.module` и
// всего, что транзитивно тянет `aws-embedded-metrics`. Ставит
// `AWS_EMF_ENVIRONMENT=Local`, иначе на Fargate без EMF Agent sidecar'а
// `flush()` падает `ECONNREFUSED 0.0.0.0:25888`. См. комментарий в
// `setup-emf-env.ts` и ADR-020 §2.5.
import './setup-emf-env';
import { Logger, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ImporterOnceModule } from './importer-once.module';
import {
  ArchiveImportService,
  TickTimeoutError,
  type TickResult,
} from './archive-import/archive-import.service';
import {
  EmfMetricsPublisher,
  type ArchiveSourceCatalogEntry,
} from './archive-import/emf-metrics.service';
import { ArchiveSourcesSeedService } from './archive-import/archive-sources-seed.service';
import { PrismaService } from './prisma/prisma.service';

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
 *   3. Hard timeout 8 минут — внутри `tickOnce()` через `Promise.race`
 *      (ADR-020 §2.2, §4.2). На таймауте бросается `TickTimeoutError` с
 *      `partial` результатом — тут же публикуется EMF по тому, что успело
 *      отработать, и делается flush → exit 124.
 *      Дополнительно: hard backstop `setTimeout(process.exit(124))` на 10
 *      минут — на случай, если даже timeout-ветка зависнет (EMF SDK,
 *      Nest shutdown hooks). Backstop срабатывает только в аномалии,
 *      штатный путь — exit через Promise.race.
 *   4. `ArchiveImportService.tickOnce()` — один проход по всем enabled-
 *      источникам, детальный результат.
 *   5. `EmfMetricsPublisher.recordSourceRun(...)` +
 *      `recordTickSummary(tick, exitCode)` + `await flush()` — публикует
 *      CloudWatch EMF до exit.
 *   6. `process.exit(code)`:
 *      - 0  → успех (включая no-op: source not due);
 *      - 1  → bootstrap/теоретический throw до вызова tickOnce;
 *      - 2  → tickOnce отработал, но хотя бы один run зафейлился
 *             (или throw'нул) — EventBridge/CloudWatch увидит non-zero
 *             exit, Alarm по SourcesFailed сработает;
 *      - 124 → таймаут (tickOnce Promise.race или backstop).
 *
 * Запуск локально:
 *   cd apps/archive-service
 *   ARCHIVE_DATABASE_URL=postgresql://... REDIS_HOST=localhost \
 *     node dist/importer-once.js
 */

const BACKSTOP_TIMEOUT_MS = 10 * 60 * 1000; // 10 мин, на 2 мин больше tickOnce
const EXIT_TIMEOUT_CODE = 124;
const EXIT_RUN_FAILED_CODE = 2;
const EXIT_BOOTSTRAP_CODE = 1;

export interface RunOutcome {
  exitCode: number;
  runsTotal: number;
  runsFailed: number;
  totalGamesAdded: number;
  /** true, если tickOnce упал по hard-таймауту (TickTimeoutError). */
  timedOut: boolean;
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
  const seed = app.get(ArchiveSourcesSeedService);
  const prisma = app.get(PrismaService);

  let tick: TickResult;
  let timedOut = false;
  let bootstrapFailed = false;
  let catalog: ArchiveSourceCatalogEntry[] = [];

  try {
    // KS-1716: гарантируем, что дефолтные источники (TWIC и т.п.) есть в БД
    // ДО tickOnce. Без этого archive_sources пустой, tickOnce возвращает
    // runs=[], и per-source `LastSuccessAgeSeconds` в EMF не публикуется —
    // CloudWatch alarm A4 остаётся навсегда в ALARM. ensureDefaults
    // идемпотентен (upsert по `code`), оператор-правки `schedule`/`cursor`
    // сохраняются.
    const seedResult = await seed.ensureDefaults();
    if (seedResult.created > 0) {
      logger.log(
        `archive_sources seeded: created=${seedResult.created} kept=${seedResult.kept}`,
      );
    }
    // KS-1716: catalog-snapshot читается ДО tickOnce и ПОСЛЕ seed, чтобы:
    //   1) гарантированно включал все enabled-источники (сид только что
    //      выполнился, TWIC точно есть в БД);
    //   2) пережил TickTimeoutError — `LastSuccessAgeSeconds` публикуется
    //      даже если processAll зависнет и отработает только backstop;
    //   3) не зависел от `tick.runs`, который для не-due источников может
    //      быть пустым (TWIC с недельным cron на обычный день).
    // Внутренний try/catch — catalog fetch fail сам по себе не считается
    // bootstrap-ошибкой процесса, importer попытается tickOnce. Emit
    // LastSuccessAgeSeconds просто пропустится, alarm A4 останется в ALARM
    // — корректная сигнализация «каталог недоступен».
    try {
      const rows = await prisma.archiveSource.findMany({
        where: { enabled: true },
        select: { code: true, lastSuccessAt: true },
      });
      catalog = rows.map((r) => ({
        code: r.code,
        lastSuccessAt: r.lastSuccessAt ?? null,
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`catalog fetch failed: ${msg}`);
    }
    tick = await archiveImport.tickOnce();
  } catch (err: unknown) {
    if (err instanceof TickTimeoutError) {
      const msg = err.message;
      logger.error(`tickOnce timeout: ${msg}`);
      // Partial runs — публикуем по ним EMF, чтобы CloudWatch видел какие
      // источники успели отработать до отключения.
      tick = err.partial;
      timedOut = true;
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`tickOnce failed: ${msg}`);
      // Bootstrap/прерывание до накопления runs — пустой tick, EMF summary
      // с exitCode=2 всё равно публикуется, CloudWatch alarm увидит событие.
      tick = { runs: [], totalGamesAdded: 0 };
      bootstrapFailed = true;
    }
  }

  const now = new Date();
  // KS-1716: сначала каталог-метрика `LastSuccessAgeSeconds{source=code}`
  // для ВСЕХ enabled-источников, независимо от due/runs. Это основной
  // сигнал для alarm A4.
  emf.recordCatalogAge(catalog, now);
  // Затем run-level метрики (GamesAdded/ImportDurationSeconds/...) — только
  // по источникам, которые реально попали в tick.runs (due / lockHeld /
  // failed). Для не-due источников этих метрик нет — корректно, т.к. они
  // описывают факт импорта, а не свойство каталога.
  for (const run of tick.runs) {
    emf.recordSourceRun(run);
  }

  const runsFailed = tick.runs.filter(
    (r) => r.error != null || r.result?.status === 'failed',
  ).length;

  let exitCode: number;
  if (timedOut) {
    exitCode = EXIT_TIMEOUT_CODE;
  } else if (bootstrapFailed || runsFailed > 0) {
    exitCode = EXIT_RUN_FAILED_CODE;
  } else {
    exitCode = 0;
  }

  emf.recordTickSummary(tick, exitCode);
  await emf.flush();

  logger.log(
    `tickOnce done: runs=${tick.runs.length} failed=${runsFailed} ` +
      `gamesAdded=${tick.totalGamesAdded} catalog=${catalog.length} ` +
      `timedOut=${timedOut} exit=${exitCode}`,
  );
  return {
    exitCode,
    runsTotal: tick.runs.length,
    runsFailed: bootstrapFailed ? 1 : runsFailed,
    totalGamesAdded: tick.totalGamesAdded,
    timedOut,
  };
}

async function bootstrap(): Promise<number> {
  // Критично: флаг должен быть выставлен ДО createApplicationContext,
  // чтобы ArchiveImportService.onModuleInit увидел его и пропустил
  // initial tick. Иначе двойной tick гарантирует пустой результат.
  process.env.IMPORTER_ONE_SHOT = '1';

  const logger = new Logger('ImporterOnce');

  // Hard backstop timeout — последняя линия защиты, если Promise.race
  // внутри tickOnce не сработал (напр., EMF SDK.flush завис, Nest
  // shutdown hooks зациклились). Штатный путь — exit через tickOnce
  // Promise.race + EMF flush → return code.
  const backstopHandle = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error(
      `[importer-once] backstop timeout ${BACKSTOP_TIMEOUT_MS}ms reached — killing process`,
    );
    process.exit(EXIT_TIMEOUT_CODE);
  }, BACKSTOP_TIMEOUT_MS);
  // unref: backstop сам по себе не держит process alive — если всё
  // штатно, exit происходит через `return outcome.exitCode`.
  backstopHandle.unref();

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
    clearTimeout(backstopHandle);
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
