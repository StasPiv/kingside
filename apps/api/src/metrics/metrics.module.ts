import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Глобальный модуль метрик.
 *
 * `@Global()` — `MetricsService` нужен во многих сервисах (archive,
 * tournament в будущем, broadcast), и тянуть его через imports[] в каждом
 * модуле — шум. Один провайдер на процесс.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
