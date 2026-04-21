/**
 * CLI shim: `node dist/cli/backfill.js` (ADR-019 §2.1).
 *
 * Поднимает `ImporterModule` через `createApplicationContext` (без HTTP
 * listener'а), достаёт `PrismaService` и `ArchivePositionWriterService`
 * из DI и вызывает `backfillLoop`.
 *
 * Логика backfill'а — в `apps/archive-service/src/archive-import/backfill.ts`
 * (единый источник правды, тестируется отдельно от DI).
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ImporterModule } from '../importer.module';
import { PrismaService } from '../prisma/prisma.service';
import { ArchivePositionWriterService } from '../archive-import/archive-position-writer.service';
import {
  backfillLoop,
  fetchExistingGameIds,
  parseArgs,
  type BackfillPrisma,
} from '../archive-import/backfill';

const PROGRESS_TAG = '[backfill]';

async function main(): Promise<void> {
  const logger = new Logger('cli:backfill');
  const options = parseArgs(process.argv.slice(2));

  const app = await NestFactory.createApplicationContext(ImporterModule, {
    bufferLogs: false,
  });
  try {
    const prisma = app.get(PrismaService);
    const writer = app.get(ArchivePositionWriterService);

    await backfillLoop(
      prisma as unknown as BackfillPrisma,
      writer,
      options,
      (ids) => fetchExistingGameIds(prisma, ids),
    );
  } finally {
    await app.close().catch((err) => {
      logger.warn(`app.close failed: ${(err as Error).message}`);
    });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`${PROGRESS_TAG} Fatal error:`, err);
  process.exit(1);
});
