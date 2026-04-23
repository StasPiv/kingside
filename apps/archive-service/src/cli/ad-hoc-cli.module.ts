import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { MetricsModule } from '../metrics/metrics.module';
import { ArchivePositionWriterService } from '../archive-import/archive-position-writer.service';
import { PositionIndexerService } from '../archive-import/position-indexer.service';
import { ArchiveImportMetricsService } from '../archive-import/archive-import-metrics.service';

/**
 * Минимальный DI-модуль для ad-hoc CLI (KS-1720).
 *
 * Контекст бага: ранее CLI `import-twic-issue.ts` (и аналоги) бутстрапили
 * `ImporterModule`. Тот тянет `ScheduleModule.forRoot()` + `ArchiveImportModule`
 * с `ArchiveImportService.onModuleInit`, который при старте делает immediate
 * `tick()` и берёт Redis-lock `archive:import:lock:twic` (TTL 30 мин). Сам CLI
 * затем падает с `lock held`, а осиротевший lock блокирует следующие ad-hoc
 * запуски в течение TTL. См. тикет KS-1719/KS-1720.
 *
 * Этот модуль:
 *   - НЕ подключает `ScheduleModule.forRoot()` — нет `@Interval`/cron;
 *   - НЕ подключает `ArchiveImportService` (и `ArchiveSourcesSeedService`) —
 *     никаких `OnModuleInit`-побочек, никакого initial tick'а;
 *   - подключает только то, что нужно ручному `new TwicImporter(prisma, source,
 *     writer, indexer, metrics)`: Prisma, Redis, prom-метрики, position writer,
 *     position indexer.
 *
 * Используется CLI-шимом `import-twic-issue.ts`. Другие CLI (`backfill.ts`,
 * `classify-existing.ts`, `cleanup-positions.ts`, `rebuild-position-stats.ts`,
 * `backfill-twic.ts`) исторически тоже стартуют от `ImporterModule` —
 * мигрировать их сюда отдельной задачей, без острой необходимости в текущем
 * цикле (ad-hoc только TWIC даёт race с lock'ом).
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
  ],
  providers: [
    ArchivePositionWriterService,
    PositionIndexerService,
    ArchiveImportMetricsService,
  ],
  exports: [
    ArchivePositionWriterService,
    PositionIndexerService,
    ArchiveImportMetricsService,
  ],
})
export class AdHocCliModule {}
