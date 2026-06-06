import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LiveAnalysisService } from './live-analysis.service';

/**
 * KS-3733 / ADR-110 §3 (lifecycle B).
 *
 * Cron каждые 5 минут — отбирает `live_analyses WHERE status='active'
 * AND lastActivityAt < NOW() - 30 min`, закрывает их и эмитит
 * `closed { reason: 'inactivity' }` через Redis pub/sub.
 *
 * Multi-instance: на каждый тик берётся Redis-lock
 * `cleanup:live-analysis:lock` (`SET ... NX EX 240`). TTL lock'а (4 мин)
 * < интервал тика (5 мин) — естественно истечёт к следующему тику и
 * не образует deadlock'а при падении инстанса. Только владелец lock'а
 * (in-process owner-stamp) делает DEL по завершении.
 *
 * Кроме чистки трансляций, в тот же тик пересчитывается gauge
 * `live_analysis_active_total` из PG — это страхует от расхождений
 * in-memory счётчика после рестарта процесса.
 *
 * Защита от перекрытий внутри одного процесса — `running` флаг (как в
 * `TacticDrillSprintScheduler`); + Redis-lock на multi-instance.
 */
@Injectable()
export class LiveAnalysisCleanupScheduler {
  private readonly logger = new Logger(LiveAnalysisCleanupScheduler.name);
  private running = false;

  constructor(private readonly service: LiveAnalysisService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.service.runCleanupTick();
      if (!result.locked) {
        this.logger.debug('cleanup tick skipped: lock held by another instance');
      } else if (result.closed > 0 || result.scanned > 0) {
        this.logger.log(
          `cleanup tick scanned=${result.scanned} closed=${result.closed}`,
        );
      }
      // Дёшево и полезно — пересчёт gauge active_total раз в 5 мин.
      await this.service.resyncActiveGauge().catch((e) =>
        this.logger.warn(`resyncActiveGauge failed: ${(e as Error).message}`),
      );
    } catch (e) {
      this.logger.error(
        `cleanup tick failed: ${(e as Error).message}`,
        (e as Error).stack,
      );
    } finally {
      this.running = false;
    }
  }
}
