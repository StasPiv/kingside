/**
 * KS-2782. CLI: `node dist/cli/backfill-variant-cleanup.js [--dry-run] [--batch-size=N] [--log-every=N]`.
 *
 * Один проход по `archive_games`: удалить partition'ы non-standard
 * вариантов (Chess960 / FischerRandom / Crazyhouse / etc.). Source-of-truth
 * — PGN-header `[Variant "..."]` (см. `isNonStandardVariantPgn` в pgn-utils).
 *
 * KS-2781 уже фильтрует новые импорты — этот CLI чистит historic
 * данные одноразово (one-shot ECS run-task).
 *
 * Связанные `puzzles.source_id` (main БД) в этой задаче НЕ трогаются:
 * связь cross-database, удаляется отдельной задачей при необходимости.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AdHocCliModule } from './ad-hoc-cli.module';
import { PrismaService } from '../prisma/prisma.service';
import {
  runBackfillVariantCleanup,
  parseBackfillVariantArgs,
  type BackfillVariantPrisma,
} from '../archive-import/backfill-variant-cleanup';

const PROGRESS_TAG = '[cli:backfill-variant-cleanup]';

async function main(): Promise<void> {
  const logger = new Logger('cli:backfill-variant-cleanup');
  const options = parseBackfillVariantArgs(process.argv.slice(2));

  const app = await NestFactory.createApplicationContext(AdHocCliModule, {
    bufferLogs: false,
  });
  try {
    const prisma = app.get(PrismaService) as unknown as BackfillVariantPrisma;
    const stats = await runBackfillVariantCleanup(
      prisma,
      (m) => logger.log(m),
      options,
    );
    logger.log(
      `${PROGRESS_TAG} FINAL: batches=${stats.batches} checked=${stats.checked} removed=${stats.removed} lastCursor=${stats.lastCursor ?? 'null'}`,
    );
  } finally {
    await app.close().catch((err) => {
      logger.warn(`app.close failed: ${(err as Error).message}`);
    });
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`${PROGRESS_TAG} Fatal error:`, err);
    process.exit(1);
  });
}
