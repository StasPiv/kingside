/**
 * KS-4695 / ADR-147 §2.2 + §8 (T1c). EventsModule собирает:
 *
 *   - HTTP-вход `POST /events` (EventsController).
 *   - Service-API `EventsService.track(actor, type, payload)` —
 *     экспортируется для T3 (self-emit из game/puzzle/...).
 *   - Background workers (EventsWriterService — Stream→PG;
 *     EventsRefreshService — REFRESH MV cron).
 *   - Prometheus метрики (EventsMetricsService — регистрируются в
 *     общий MetricsService.registry, отдаются на `/metrics`).
 *
 * Зависимости:
 *   - PrismaModule (global) — для чтения `User.analyticsConsent`.
 *   - RedisModule (global) — `XADD/XREADGROUP/XACK/XPENDING` + hot counters.
 *   - MetricsModule — общий Prometheus registry.
 *   - AuthModule — JwtService для decode'а Bearer в EventsController.
 *   - @kingside/events-db (через EventsPrismaService) — writer + owner
 *     PrismaClient'ы.
 *
 * GuestIdMiddleware — НЕ часть этого модуля (он лежит в common/),
 * подключается в AppModule.configure() на `*`-роутах: ему нужны все
 * страницы для rolling-renew cookie, не только `/events/*`.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MetricsModule } from '../metrics/metrics.module';
import { EventsController } from './events.controller';
import { EventsMetricsService } from './events-metrics.service';
import { EventsPrismaService } from './events-prisma.service';
import { EventsRefreshService } from './events-refresh.service';
import { EventsService } from './events.service';
import { EventsWriterService } from './events-writer.service';

@Module({
  imports: [AuthModule, MetricsModule],
  controllers: [EventsController],
  providers: [
    EventsService,
    EventsMetricsService,
    EventsPrismaService,
    EventsWriterService,
    EventsRefreshService,
  ],
  exports: [EventsService, EventsMetricsService],
})
export class EventsModule {}
