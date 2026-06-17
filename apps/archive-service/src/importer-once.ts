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
import { resolveBackstopTimeoutMs } from './archive-import/importer-timeouts';

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
 *   3. Hard timeout `tickOnce()` через `Promise.race` (ADR-020 §2.2,
 *      §4.2; default 30 мин — KS-2123, env `IMPORTER_TICK_TIMEOUT_MS`).
 *      На таймауте бросается `TickTimeoutError` с `partial` результатом —
 *      тут же публикуется EMF по тому, что успело отработать, и делается
 *      flush → exit 124. Дополнительно: hard backstop
 *      `setTimeout(process.exit(124))` (default 35 мин — KS-2123, env
 *      `IMPORTER_BACKSTOP_TIMEOUT_MS`) — на случай, если даже timeout-ветка
 *      зависнет (EMF SDK, Nest shutdown hooks). Backstop срабатывает только
 *      в аномалии, штатный путь — exit через Promise.race.
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

// KS-2123: backstop вынесен в env (`IMPORTER_BACKSTOP_TIMEOUT_MS`, default
// 35 мин), чтобы держать запас выше нового tickOnce (30 мин). Прежний 10-мин
// backstop срабатывал раньше, чем tickOnce успевал догнать новые TWIC weekly
// размером ~7K партий.
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
    if (seedResult.created > 0 || seedResult.healed > 0) {
      logger.log(
        `archive_sources seeded: created=${seedResult.created} healed=${seedResult.healed} kept=${seedResult.kept}`,
      );
    }
    // KS-1716: до tickOnce читаем `archive_sources` только для логирования
    // total/enabled. Для метрики `LastSuccessAgeSeconds` этот снимок
    // НЕ используется — он стал бы протухшим сразу после успешного
    // импорта (KS-4313: значение `lastSuccessAt` шло в EMF старое, метрика
    // монотонно росла независимо от реальных прогонов). Свежий снимок
    // берётся ПОСЛЕ tickOnce — там, где БД уже обновлена.
    try {
      const rows = await prisma.archiveSource.findMany({
        select: { code: true, enabled: true },
      });
      const enabledRows = rows.filter((r) => r.enabled);
      logger.log(
        `archive_sources: total=${rows.length} enabled=${enabledRows.length} ` +
          `codes=[${rows.map((r) => `${r.code}:${r.enabled ? 'on' : 'off'}`).join(',')}]`,
      );
      if (rows.length > 0 && enabledRows.length === 0) {
        logger.warn(
          'all archive_sources are disabled — catalog metric LastSuccessAgeSeconds will be empty',
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`catalog pre-tick fetch failed: ${msg}`);
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
  // KS-4313: каталог-снимок читается ПОСЛЕ tickOnce, чтобы
  // `LastSuccessAgeSeconds` отражал свежие значения, обновлённые
  // импортёром (TWIC писал `lastSuccessAt = new Date()` в БД). Раньше
  // снимок брался до tickOnce и метрика монотонно росла, давая ложное
  // впечатление многодневной задержки даже после успешных прогонов.
  //
  // Внутренний try/catch — fail post-tick catalog fetch'а не считается
  // ошибкой процесса; emit LastSuccessAgeSeconds просто пропустится,
  // alarm A4 останется в ALARM — корректная сигнализация «каталог
  // недоступен».
  try {
    const enabledRows = await prisma.archiveSource.findMany({
      where: { enabled: true },
      select: { code: true, lastSuccessAt: true },
    });
    catalog = enabledRows.map((r) => ({
      code: r.code,
      lastSuccessAt: r.lastSuccessAt ?? null,
    }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`catalog post-tick fetch failed: ${msg}`);
  }
  // KS-1716: каталог-метрика `LastSuccessAgeSeconds{source=code}` для
  // ВСЕХ enabled-источников, независимо от due/runs. Основной сигнал
  // для alarm A4.
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
  // KS-2123: значение берётся из env `IMPORTER_BACKSTOP_TIMEOUT_MS`,
  // default 35 мин (на 5 мин выше tickOnce default 30 мин).
  const backstopTimeoutMs = resolveBackstopTimeoutMs();
  const backstopHandle = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error(
      `[importer-once] backstop timeout ${backstopTimeoutMs}ms reached — killing process`,
    );
    process.exit(EXIT_TIMEOUT_CODE);
  }, backstopTimeoutMs);
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
