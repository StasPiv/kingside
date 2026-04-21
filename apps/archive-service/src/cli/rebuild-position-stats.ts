/**
 * CLI shim: `node dist/cli/rebuild-position-stats.js` (ADR-019 §2.1).
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ImporterModule } from '../importer.module';
import { PrismaService } from '../prisma/prisma.service';
import { PositionIndexerService } from '../archive-import/position-indexer.service';
import { rebuildPositionStats } from '../archive-import/rebuild-position-stats';

const PROGRESS_TAG = '[rebuild-position-stats]';

async function main(): Promise<void> {
  const logger = new Logger('cli:rebuild-position-stats');
  const app = await NestFactory.createApplicationContext(ImporterModule, {
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
