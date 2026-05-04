/**
 * KS-2380. Cron-scheduler авто-финала просроченных sprint-сессий.
 *
 * Жалоба: пользователь прошёл sprint, но в лидерборде записи нет —
 * потому что финал зависит от последнего `/sprint/submit` (после
 * истечения таймера) либо явного `/sprint/finish`. Если фронт не вызвал
 * ни того, ни другого (вкладка закрыта, навигация на /leaderboard
 * без finish-вызова и т. д.), сессия в Redis висит до TTL и беззвучно
 * удаляется — записи в `tactic_drill_sprint_scores` не появляется.
 *
 * Расписание: `EVERY_MINUTE`. С TTL Redis-сессии = durationMs+60s
 * (max 6 минут для 5min-sprint) одна минута даёт верхнюю границу
 * задержки финализации ≤60s после таймера; запись в лидерборде
 * появляется почти сразу после окончания.
 *
 * Защита от перекрытий: `running` lock — если предыдущий tick ещё
 * сканирует Redis, второй вызов делает no-op. Атомарность
 * финализации — на уровне `redis.del` в
 * `TacticDrillSprintService.autoFinalizeExpiredSessions`.
 *
 * Multi-instance: безопасно. На проде N инстансов api → N тиков
 * параллельно сканируют, но `redis.del` в guard'е `autoFinalize`
 * атомарен: только один из N инстансов получит `removed=1` и
 * запишет score.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TacticDrillSprintService } from './tactic-drill-sprint.service';

@Injectable()
export class TacticDrillSprintScheduler {
  private readonly logger = new Logger(TacticDrillSprintScheduler.name);
  private running = false;

  constructor(private readonly sprintService: TacticDrillSprintService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.sprintService.autoFinalizeExpiredSessions();
      if (r.scanned > 0) {
        this.logger.log(
          `auto-finalize tick scanned=${r.scanned} finalized=${r.finalized} skipped=${r.skipped}`,
        );
      }
    } catch (e) {
      this.logger.error(
        `auto-finalize tick failed: ${(e as Error).message}`,
        (e as Error).stack,
      );
    } finally {
      this.running = false;
    }
  }
}
