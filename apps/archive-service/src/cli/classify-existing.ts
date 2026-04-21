/**
 * CLI shim: `node dist/cli/classify-existing.js` (ADR-019 §2.1).
 *
 * Поднимает `ImporterModule` через `createApplicationContext`, достаёт
 * `PrismaService` из DI и делегирует в `classifyExisting`.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ImporterModule } from '../importer.module';
import { PrismaService } from '../prisma/prisma.service';
import { classifyExisting } from '../archive-import/classify-existing';

const PROGRESS_TAG = '[classify-existing]';

async function main(): Promise<void> {
  const logger = new Logger('cli:classify-existing');
  const app = await NestFactory.createApplicationContext(ImporterModule, {
    bufferLogs: false,
  });
  try {
    const prisma = app.get(PrismaService);
    await classifyExisting(prisma);
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
