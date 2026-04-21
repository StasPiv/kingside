import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Глобальный модуль метрик archive-service.
 *
 * `@Global()` — `MetricsService` нужен в ArchiveMetricsService и потенциально
 * в других сервисах. Один провайдер на процесс.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
