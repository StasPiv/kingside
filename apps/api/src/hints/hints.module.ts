/**
 * KS-4699 / ADR-147 §3 + §4 + §5. HintsModule:
 *
 *   - HintsService (checkFor + smart-dismiss) — exports для T8.
 *   - HintsLimitsService (env-driven, см. шапку файла) — exports
 *     для T8 (lifecycle bump throttle при receive).
 *   - HintsMetricsService — регистрирует метрики в общий /metrics.
 *   - HintsListener — подписывается на EventsService.onTrack.
 *
 * HTTP-контроллера здесь нет — это T8 (WS emit + REST lifecycle +
 * pull endpoint для guest).
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GuestModule } from '../guest/guest.module';
import { MessageModule } from '../message/message.module';
import { MetricsModule } from '../metrics/metrics.module';
import { HintsAdminController } from './admin/hints-admin.controller';
import { HintsAdminService } from './admin/hints-admin.service';
import { HintsController } from './hints.controller';
import { HintsLimitsService } from './hints-limits.service';
// KS-4783: отключён вместе с EventsWriterService (см. EventsModule).
// Включить обратно после переноса XREADGROUP на отдельный duplicate()-клиент.
// import { HintsListener } from './hints.listener';
import { HintsMetricsService } from './hints-metrics.service';
import { HintsService } from './hints.service';

@Module({
  // KS-4701: MessageModule — для WS-emit hint:show через MessageGateway.
  //          GuestModule — для GuestIdGuard в /hints/pending.
  //          AuthModule — для JwtService decode в HintsController.
  // KS-4702: AuthModule — также для AdminOrServiceGuard цепочки в admin-CRUD.
  imports: [MetricsModule, AuthModule, MessageModule, GuestModule],
  controllers: [HintsController, HintsAdminController],
  providers: [
    HintsService,
    HintsLimitsService,
    HintsMetricsService,
    // HintsListener,  // KS-4783: см. шапку import
    HintsAdminService,
  ],
  exports: [HintsService, HintsLimitsService, HintsMetricsService],
})
export class HintsModule {}
