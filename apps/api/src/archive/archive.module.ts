import { Module, Provider } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ArchiveController } from './archive.controller';
import { ArchiveService } from './archive.service';
import {
  ARCHIVE_STATS_REPOSITORY,
  PostgresArchiveStatsRepository,
} from './archive-stats.repository';
import { ArchiveMetricsService } from './archive-metrics.service';

/**
 * Wires the ArchiveStatsRepository implementation based on the
 * `ARCHIVE_STATS_IMPL` env var. Only `postgres` is available today;
 * `clickhouse` will be added in Phase C without touching the controller
 * or service (ADR-013 §10.C.4).
 */
const statsRepositoryProvider: Provider = {
  provide: ARCHIVE_STATS_REPOSITORY,
  useFactory: (prisma: PrismaService) => {
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
  inject: [PrismaService],
};

@Module({
  controllers: [ArchiveController],
  providers: [ArchiveService, ArchiveMetricsService, statsRepositoryProvider],
  exports: [ArchiveService, ArchiveMetricsService],
})
export class ArchiveModule {}
