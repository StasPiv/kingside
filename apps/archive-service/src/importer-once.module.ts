import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { MetricsModule } from './metrics/metrics.module';
import { ArchiveImportModule } from './archive-import/archive-import.module';
import { EmfMetricsPublisher } from './archive-import/emf-metrics.service';

/**
 * Root-module для one-shot importer-процесса (KS-1681, ADR-020 §0).
 *
 * Отличия от `ImporterModule` (long-lived, ADR-019 §2.1):
 *   - БЕЗ `ScheduleModule` — в one-shot не нужен `@Interval` cron'ник, всё
 *     выполняется явным вызовом `ArchiveImportService.tickOnce()`;
 *   - БЕЗ `HealthModule` — нет HTTP-endpoint'ов, процесс запускается
 *     `NestFactory.createApplicationContext(...)` и завершается после
 *     публикации EMF;
 *   - добавляет `EmfMetricsPublisher` (CloudWatch EMF) для short-lived
 *     метрик — prom-client в short-lived не имеет смысла, т.к. scrape
 *     не успевает.
 *
 * `MetricsModule` оставлен: от него зависит `ArchiveImportMetricsService`
 * (prom-client регистр). Его метрики в one-shot процессе не публикуются
 * (нет scrape-endpoint'а), но поведение `TwicImporter` зависит от
 * `ArchiveImportMetricsService.timeImport(...)` — метрики будут жить в
 * in-memory registry и сбросятся вместе с процессом. Это допустимо:
 * бизнес-метрики уезжают в CloudWatch через `EmfMetricsPublisher`.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
    }),
    PrismaModule,
    RedisModule,
    MetricsModule,
    ArchiveImportModule,
  ],
  providers: [EmfMetricsPublisher],
  exports: [EmfMetricsPublisher],
})
export class ImporterOnceModule {}
