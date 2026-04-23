/**
 * CLI shim: `node dist/cli/import-twic-issue.js <issue>` (KS-1679).
 *
 * Ad-hoc-импорт конкретного TWIC-выпуска по номеру. НЕ трогает
 * `archive_sources.cursor` — scheduler продолжит работать от своего
 * курсора. Используется для наращивания архива выпусками «назад» (1639,
 * 1638, …) с ручной проверкой метрик между итерациями.
 *
 * Делает Redis-`PUBLISH archive:imported` при `games_added > 0`, чтобы
 * HTTP-процесс archive-service сбросил кеш `/tree` и `/games`.
 *
 * Использует тот же Redis-lock `archive:import:lock:twic` что и
 * scheduler — параллельный scheduler-tick увидит `lock held, skipping`
 * и корректно пропустит свой заход (ADR-019 §2.11).
 *
 * KS-1720: bootstrap идёт через `AdHocCliModule` (без `ScheduleModule`,
 * без `ArchiveImportService`). Раньше использовался `ImporterModule` —
 * `ArchiveImportService.onModuleInit` делал immediate tick, брал lock и
 * ронял сам CLI с `lock held`. Любой ad-hoc после этого ждал TTL 30 мин.
 */

import 'reflect-metadata';
import type Redis from 'ioredis';
import type { PrismaClient } from '@kingside/archive-db';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AdHocCliModule } from './ad-hoc-cli.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ArchivePositionWriterService } from '../archive-import/archive-position-writer.service';
import { PositionIndexerService } from '../archive-import/position-indexer.service';
import { ArchiveImportMetricsService } from '../archive-import/archive-import-metrics.service';
import {
  TwicImporter,
  type ArchiveSourceRow,
  type ImportResult,
} from '../archive-import/sources/twic.importer';

const PROGRESS_TAG = '[cli:import-twic-issue]';
const ARCHIVE_IMPORTED_CHANNEL = 'archive:imported';
const LOCK_KEY = 'archive:import:lock:twic';
const LOCK_TTL_SEC = 30 * 60;

export interface ImportTwicIssueArgs {
  issue: number;
}

/**
 * Парсит `process.argv.slice(2)` → `{ issue }`. Бросает ошибку с полной
 * подсказкой по usage при неверном вводе — CLI затем ловит и выходит
 * с кодом 1.
 */
export function parseArgs(argv: readonly string[]): ImportTwicIssueArgs {
  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length === 0) {
    throw new Error('Usage: import-twic-issue <issue>');
  }
  if (positional.length > 1) {
    throw new Error(
      `Expected exactly one positional argument (issue), got ${positional.length}: ${positional.join(', ')}`,
    );
  }
  const raw = positional[0];
  const issue = Number.parseInt(raw, 10);
  if (!Number.isFinite(issue) || issue <= 0 || String(issue) !== raw.trim()) {
    throw new Error(`Invalid issue number: "${raw}" (expected positive integer)`);
  }
  return { issue };
}

/**
 * Минимальный DI-surface для тестирования. `main()` собирает его через
 * `NestFactory.createApplicationContext`; тест подсовывает моки.
 */
export interface ImportTwicIssueDeps {
  prisma: PrismaClient;
  redis: Pick<Redis, 'set' | 'del' | 'publish'>;
  makeImporter: (source: ArchiveSourceRow) => Pick<TwicImporter, 'runAdHoc'>;
  logger: Pick<Logger, 'log' | 'warn' | 'error'>;
}

/**
 * Ядро CLI: достаёт `archive_sources.code='twic'`, берёт Redis-lock,
 * вызывает `TwicImporter.runAdHoc(issue)`, публикует событие при
 * `gamesAdded > 0`. Lock отпускается в finally.
 *
 * Возвращает `ImportResult` для анализа в main() / тестах.
 */
export async function runImportTwicIssue(
  deps: ImportTwicIssueDeps,
  args: ImportTwicIssueArgs,
): Promise<ImportResult> {
  const { prisma, redis, makeImporter, logger } = deps;

  const source = await prisma.archiveSource.findFirst({
    where: { code: 'twic' },
  });
  if (!source) {
    throw new Error('archive_sources row with code="twic" not found');
  }

  const acquired = await redis
    .set(LOCK_KEY, `${process.pid}:${Date.now()}:adhoc`, 'EX', LOCK_TTL_SEC, 'NX')
    .catch(() => null);
  if (acquired !== 'OK') {
    throw new Error(
      `lock "${LOCK_KEY}" is held — scheduler or another CLI is importing twic right now; try again in a minute`,
    );
  }

  try {
    const importer = makeImporter({
      id: source.id,
      code: source.code,
      cursor: source.cursor ?? null,
    });
    logger.log(
      `${PROGRESS_TAG} issue=${args.issue} source.cursor=${source.cursor ?? 'null'} — starting ad-hoc import (cursor will NOT change)`,
    );
    const result = await importer.runAdHoc(args.issue);
    logger.log(
      `${PROGRESS_TAG} issue=${args.issue} status=${result.status} ` +
        `parsed=${result.gamesParsed} added=${result.gamesAdded} skipped=${result.gamesSkipped}` +
        (result.error ? ` error="${result.error}"` : ''),
    );

    if (result.gamesAdded > 0) {
      try {
        const n = await redis.publish(
          ARCHIVE_IMPORTED_CHANNEL,
          `twic:${args.issue}`,
        );
        logger.log(
          `${PROGRESS_TAG} PUBLISH ${ARCHIVE_IMPORTED_CHANNEL} → ${n} subscriber(s)`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Кеш всё равно инвалидируется по TTL — не фатально.
        logger.warn(
          `${PROGRESS_TAG} redis publish failed (cache will TTL-expire): ${msg}`,
        );
      }
    }

    return result;
  } finally {
    await redis.del(LOCK_KEY).catch(() => {
      logger.warn(`${PROGRESS_TAG} failed to release ${LOCK_KEY} (will TTL-expire in ${LOCK_TTL_SEC}s)`);
    });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // KS-1720: используем `AdHocCliModule`, а не `ImporterModule`. Тот тянул
  // `ScheduleModule` + `ArchiveImportService` с `OnModuleInit`-immediate
  // tick'ом — при bootstrap ad-hoc CLI он успевал захватить
  // `archive:import:lock:twic`, после чего сам CLI падал с `lock held`,
  // а осиротевший lock блокировал любые ad-hoc запуски на 30 мин TTL.
  const app = await NestFactory.createApplicationContext(AdHocCliModule, {
    bufferLogs: false,
  });
  const logger = new Logger('cli:import-twic-issue');
  let exitCode = 0;
  try {
    const prisma = app.get(PrismaService);
    const redis = app.get(RedisService);
    const writer = app.get(ArchivePositionWriterService);
    const indexer = app.get(PositionIndexerService);
    const metrics = app.get(ArchiveImportMetricsService);

    const result = await runImportTwicIssue(
      {
        prisma,
        redis,
        makeImporter: (source) =>
          new TwicImporter(prisma, source, writer, indexer, metrics),
        logger,
      },
      args,
    );

    if (result.status === 'failed') {
      // Невозможный URL, 5xx от TWIC, unzip-fail, DB error — все эти ветки
      // ставят status='failed' в `TwicImporter.runForIssue`. Помимо лога
      // нужен non-zero exit, чтобы оркестратор (bash-loop) остановился.
      logger.error(`${PROGRESS_TAG} import failed: ${result.error ?? 'unknown'}`);
      exitCode = 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`${PROGRESS_TAG} Fatal error: ${msg}`);
    exitCode = 1;
  } finally {
    await app.close().catch((err) => {
      logger.warn(`app.close failed: ${(err as Error).message}`);
    });
  }
  process.exit(exitCode);
}

// Запускаем только когда файл — точка входа (node dist/cli/import-twic-issue.js).
// В тестах файл импортируется — main() не вызывается (см. условие ниже),
// что позволяет проверить `parseArgs` / `runImportTwicIssue` независимо.
if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`${PROGRESS_TAG} Fatal error:`, err);
    process.exit(1);
  });
}
