import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { MetricsModule } from './metrics/metrics.module';
import { HealthModule } from './health/health.module';
import { ArchiveImportModule } from './archive-import/archive-import.module';

/**
 * Root-module для importer-процесса archive-service (ADR-019 §2.1).
 *
 * Поднимает:
 *   - `/_/health` (HealthModule) и `/_/metrics` (MetricsModule, @Global) на
 *     `ARCHIVE_IMPORTER_PORT` (дефолт 3004) — scrape и liveness отдельно от
 *     HTTP-процесса archive-service;
 *   - `ArchiveImportService` с `@Interval(60_000)` tick'ом;
 *   - `PrismaService` и `RedisService` — те же, что у HTTP-процесса.
 *
 * `ArchiveModule` (controller `/tree`, `/games/...`) НЕ подключается —
 * importer-процесс не должен обслуживать публичные архивные endpoints.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    MetricsModule,
    HealthModule,
    ArchiveImportModule,
  ],
})
export class ImporterModule {}
