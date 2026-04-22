import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Глобальный модуль метрик broadcast-service.
 *
 * `@Global()` — `MetricsService` нужен в BroadcastGateway и потенциально в
 * других сервисах. Один провайдер на процесс.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
