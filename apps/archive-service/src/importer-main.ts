import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ImporterModule } from './importer.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

/**
 * archive-importer bootstrap (ADR-019 §2.1).
 *
 * Standalone-процесс, поднимает только `/_/health` и `/_/metrics` на
 * `ARCHIVE_IMPORTER_PORT` (дефолт 3004). Scheduler включён через
 * `@Interval(60_000)` в `ArchiveImportService` — tick'ает сам.
 *
 * Отдельно от `main.ts` (HTTP archive-service на 3003) специально: один
 * экземпляр scheduler'а на кластер, HTTP реплики не должны тикнуть
 * (ADR-019 §2.2).
 */
async function bootstrap() {
  const logger = new Logger('ArchiveImporter');
  const app = await NestFactory.create(ImporterModule);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const port = process.env.ARCHIVE_IMPORTER_PORT || 3004;
  await app.listen(port, '0.0.0.0');
  logger.log(`archive-importer listening on http://0.0.0.0:${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[archive-importer] Fatal error:', err);
  process.exit(1);
});
