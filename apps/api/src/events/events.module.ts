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
import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MetricsModule } from '../metrics/metrics.module';
import { AnalyticsDataService } from './analytics-data.service';
import { EventsController } from './events.controller';
// KS-4748 / ADR-149 G2: internal-канал для эмита событий из game-service.
import { InternalEventsController } from './internal-events.controller';
import { InternalEventsGuard } from './internal-events.guard';
import { EventsMetricsService } from './events-metrics.service';
import { EventsPrismaService } from './events-prisma.service';
import { EventsRefreshService } from './events-refresh.service';
import { EventsService } from './events.service';
import { EventsWriterService } from './events-writer.service';

// KS-4696 / ADR-147 §2.2 (T3): @Global чтобы EventsService инжектился в
// game/puzzle/lessons/tactic-drill/analysis для self-emit без явного
// `imports: [EventsModule]` в десятке модулей. EventsService — типичный
// cross-cutting сервис, ровно тот случай, для которого делается Global
// (как RedisModule / MetricsModule).
@Global()
@Module({
  imports: [AuthModule, MetricsModule],
  controllers: [EventsController, InternalEventsController],
  providers: [
    EventsService,
    EventsMetricsService,
    EventsPrismaService,
    EventsWriterService,
    EventsRefreshService,
    InternalEventsGuard,
    // KS-4697 / ADR-147 §6.3 + §1.1: общая логика GDPR-операций
    // и guest→user merge. Используется MeController/GuestController/
    // AuthService.
    AnalyticsDataService,
  ],
  // KS-4701: EventsPrismaService экспортируется для HintsModule
  // (HintsService и HintsAdminService напрямую читают/пишут schema
  // events через owner-PrismaClient). Без этого DI в HintsModule
  // падает UnknownDependenciesException на старте Nest.
  exports: [EventsService, EventsMetricsService, AnalyticsDataService, EventsPrismaService],
})
export class EventsModule {}
