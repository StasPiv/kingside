/**
 * KS-4247 / ADR-131 A1. Модуль archive в составе apps/api.
 * `@Controller('archive')` под префиксом /archive (защита от
 * конфликта с уже существующими `@Controller('games')` и
 * `@Controller('players')` в apps/api).
 *
 * Второй PrismaClient (`ArchivePrismaService`) рядом с основным
 * `PrismaService` — отдельный пул соединений к `archive_kingside` DB
 * через env `ARCHIVE_DATABASE_URL`.
 *
 * После A2 (devops) фронт через CloudFront/ALB rewrite
 * `archive.kingside.site/{path}` → `api.kingside.site/archive/{path}`
 * попадает сюда, контракт API не меняется.
 */
import { Module, type Provider } from '@nestjs/common';
import { ArchivePrismaService } from './archive-prisma.service';
import { ArchiveController } from './archive.controller';
import { ArchiveService } from './archive.service';
import {
  ARCHIVE_STATS_REPOSITORY,
  PostgresArchiveStatsRepository,
} from './archive-stats.repository';
import { ArchiveMetricsService } from './archive-metrics.service';

/**
 * Wires the ArchiveStatsRepository implementation based on the
 * `ARCHIVE_STATS_IMPL` env var (ADR-013 §10.C.4).
 */
const statsRepositoryProvider: Provider = {
  provide: ARCHIVE_STATS_REPOSITORY,
  useFactory: (prisma: ArchivePrismaService) => {
    const impl = (process.env.ARCHIVE_STATS_IMPL ?? 'postgres').toLowerCase();
    switch (impl) {
      case 'postgres':
        return new PostgresArchiveStatsRepository(prisma);
      case 'clickhouse':
        throw new Error(
          'ARCHIVE_STATS_IMPL=clickhouse is not implemented yet (Phase C)',
        );
      default:
        throw new Error(`Unknown ARCHIVE_STATS_IMPL: ${impl}`);
    }
  },
  inject: [ArchivePrismaService],
};

@Module({
  controllers: [ArchiveController],
  providers: [
    ArchivePrismaService,
    ArchiveService,
    ArchiveMetricsService,
    statsRepositoryProvider,
  ],
  exports: [ArchiveService, ArchiveMetricsService, ArchivePrismaService],
})
export class ArchiveModule {}
