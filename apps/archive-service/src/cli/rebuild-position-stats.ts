/**
 * CLI shim: `node dist/cli/rebuild-position-stats.js` (ADR-019 §2.1).
 *
 * KS-1722: bootstrap через `AdHocCliModule`, без `ScheduleModule` и без
 * `ArchiveImportService`-immediate tick'а (см. KS-1720).
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AdHocCliModule } from './ad-hoc-cli.module';
import { PrismaService } from '../prisma/prisma.service';
import { PositionIndexerService } from '../archive-import/position-indexer.service';
import { rebuildPositionStats } from '../archive-import/rebuild-position-stats';

const PROGRESS_TAG = '[rebuild-position-stats]';

async function main(): Promise<void> {
  const logger = new Logger('cli:rebuild-position-stats');
  const app = await NestFactory.createApplicationContext(AdHocCliModule, {
    bufferLogs: false,
  });
  try {
    const prisma = app.get(PrismaService);
    const indexer = app.get(PositionIndexerService);
    await rebuildPositionStats(prisma, indexer);
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
