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
import { MetricsModule } from '../metrics/metrics.module';
import { HintsLimitsService } from './hints-limits.service';
import { HintsListener } from './hints.listener';
import { HintsMetricsService } from './hints-metrics.service';
import { HintsService } from './hints.service';

@Module({
  imports: [MetricsModule],
  providers: [HintsService, HintsLimitsService, HintsMetricsService, HintsListener],
  exports: [HintsService, HintsLimitsService, HintsMetricsService],
})
export class HintsModule {}
