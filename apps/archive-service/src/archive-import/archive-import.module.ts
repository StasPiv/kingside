import { Module } from '@nestjs/common';
import { ArchiveImportService } from './archive-import.service';
import { ArchiveImportMetricsService } from './archive-import-metrics.service';
import { ArchivePositionWriterService } from './archive-position-writer.service';
import { PositionIndexerService } from './position-indexer.service';
import { ArchiveSourcesSeedService } from './archive-sources-seed.service';

/**
 * DI-модуль importer'а (ADR-019 §2.1).
 *
 * Не подключает controllers: importer-процесс получает `/_/health` +
 * `/_/metrics` от `HealthModule`/`MetricsModule`, которые подключены в
 * `ImporterModule` напрямую (оба @Global).
 *
 * Экспортируем сервисы, чтобы CLI-шim'ы (`cli/backfill.ts` и пр.) могли
 * достать их из `NestFactory.createApplicationContext`.
 */
@Module({
  providers: [
    ArchiveImportService,
    ArchiveImportMetricsService,
    ArchivePositionWriterService,
    PositionIndexerService,
    ArchiveSourcesSeedService,
  ],
  exports: [
    ArchiveImportService,
    ArchiveImportMetricsService,
    ArchivePositionWriterService,
    PositionIndexerService,
    ArchiveSourcesSeedService,
  ],
})
export class ArchiveImportModule {}
