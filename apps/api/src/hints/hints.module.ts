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
import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GuestModule } from '../guest/guest.module';
import { MessageModule } from '../message/message.module';
import { MetricsModule } from '../metrics/metrics.module';
import { HintsAdminController } from './admin/hints-admin.controller';
import { HintsAdminService } from './admin/hints-admin.service';
import { HintsController } from './hints.controller';
import { HintsLimitsService } from './hints-limits.service';
import { HintsListener } from './hints.listener';
import { HintsMetricsService } from './hints-metrics.service';
import { HintsService } from './hints.service';

@Module({
  // KS-4701: MessageModule — для WS-emit hint:show через MessageGateway.
  //          GuestModule — для GuestIdGuard в /hints/pending.
  //          AuthModule — для JwtService decode в HintsController.
  // KS-4702: AuthModule — также для AdminOrServiceGuard цепочки в admin-CRUD.
  // KS-4786: MessageModule через `forwardRef` — теперь MessageGateway
  // инжектит HintsService (replay на handleConnection), а HintsModule
  // импортирует MessageModule. Без `forwardRef` ES-модуль импорта
  // MessageModule возвращает undefined → UndefinedModuleException на
  // bootstrap.
  imports: [MetricsModule, AuthModule, forwardRef(() => MessageModule), GuestModule],
  controllers: [HintsController, HintsAdminController],
  providers: [
    HintsService,
    HintsLimitsService,
    HintsMetricsService,
    HintsListener,
    HintsAdminService,
  ],
  exports: [HintsService, HintsLimitsService, HintsMetricsService],
})
export class HintsModule {}
