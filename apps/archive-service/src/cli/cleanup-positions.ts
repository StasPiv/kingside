/**
 * CLI shim: `node dist/cli/cleanup-positions.js` (ADR-019 §2.1).
 *
 * KS-1722: bootstrap через `AdHocCliModule`, без `ScheduleModule` и без
 * `ArchiveImportService`-immediate tick'а (см. KS-1720).
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AdHocCliModule } from './ad-hoc-cli.module';
import { PrismaService } from '../prisma/prisma.service';
import { cleanupPositions } from '../archive-import/cleanup-positions';

const PROGRESS_TAG = '[cleanup-positions]';

async function main(): Promise<void> {
  const logger = new Logger('cli:cleanup-positions');
  const app = await NestFactory.createApplicationContext(AdHocCliModule, {
    bufferLogs: false,
  });
  try {
    const prisma = app.get(PrismaService);
    await cleanupPositions(prisma);
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
