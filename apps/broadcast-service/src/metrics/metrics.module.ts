import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { HttpDurationInterceptor } from './http-duration.interceptor';

/**
 * Глобальный модуль метрик broadcast-service.
 *
 * `@Global()` — `MetricsService` нужен в BroadcastGateway и потенциально в
 * других сервисах. Один провайдер на процесс.
 *
 * `APP_INTERCEPTOR` — глобальный HTTP-interceptor, который пишет histogram
 * `broadcast_http_query_duration_seconds{route}`. До KS-1710 histogram был
 * зарегистрирован, но `.observe()` не вызывался.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    { provide: APP_INTERCEPTOR, useClass: HttpDurationInterceptor },
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
