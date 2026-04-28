/**
 * CLI-шим: `node dist/cli/backfill-players-events.js` (KS-2064).
 *
 * One-shot заполнение нормализованных таблиц `archive_players` /
 * `archive_events` и материализованного view `archive_player_stats`
 * по корпусу `archive_games` (ADR-033 §4.4.5).
 *
 * Контракт:
 *   - Без аргументов и env-флагов: сканирует весь `archive_games`,
 *     TRUNCATE'ает целевые таблицы и заливает агрегаты.
 *   - REFRESH MV: первый прогон — без CONCURRENTLY (MV пуст после
 *     CREATE), повторные ручные запуски — пытается CONCURRENTLY и
 *     fallback при отказе.
 *
 * Bootstrap — `AdHocCliModule` (без scheduler, без onModuleInit-tick'ов;
 * см. KS-1720).
 *
 * Exit codes:
 *   - 0 — успешный backfill;
 *   - 1 — bootstrap / unexpected throw.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AdHocCliModule } from './ad-hoc-cli.module';
import { PlayersEventsBackfillService } from '../archive-import/players-events-backfill.service';

const PROGRESS_TAG = '[backfill-players-events]';
const EXIT_OK = 0;
const EXIT_BOOTSTRAP = 1;

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AdHocCliModule, {
    bufferLogs: false,
  });
  const logger = new Logger('cli:backfill-players-events');
  let exitCode: number = EXIT_OK;

  try {
    const svc = app.get(PlayersEventsBackfillService);
    const report = await svc.backfillAll();

    logger.log(
      `${PROGRESS_TAG} done: scanned=${report.scannedGames} ` +
        `players=${report.insertedPlayers} events=${report.insertedEvents} ` +
        `mv=${report.refreshedViewMode} ${report.durationMs}ms`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`${PROGRESS_TAG} Fatal error: ${msg}`);
    exitCode = EXIT_BOOTSTRAP;
  } finally {
    await app.close().catch((err) => {
      logger.warn(`app.close failed: ${(err as Error).message}`);
    });
  }
  process.exit(exitCode);
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`${PROGRESS_TAG} Fatal error:`, err);
    process.exit(EXIT_BOOTSTRAP);
  });
}
