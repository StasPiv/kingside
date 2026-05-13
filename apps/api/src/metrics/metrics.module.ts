import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { McpExclude } from '../mcp/decorators';

/**
 * Глобальный модуль метрик.
 *
 * `@Global()` — `MetricsService` нужен во многих сервисах (archive,
 * tournament в будущем, broadcast), и тянуть его через imports[] в каждом
 * модуле — шум. Один провайдер на процесс.
 *
 * KS-2954 (ADR-061 §8): Prometheus-метрики бесполезны ассистенту и могут
 * утечь чувствительные RPS-цифры. `@McpExclude` обязателен.
 */
@McpExclude()
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
