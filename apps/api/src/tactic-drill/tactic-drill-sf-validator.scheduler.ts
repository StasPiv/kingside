/**
 * KS-2247 (ADR-035 §6.3 R5). Cron-scheduler фоновой Stockfish-валидации
 * drill'ов с риском неоднозначности.
 *
 * Логика:
 *   - `@Cron(EVERY_HOUR)` — берёт `LIMIT N` неvalidированных
 *     drill'ов типа `find-hanging-piece` (KS-2393: тип
 *     `mate-in-1 (deprecated)` удалён, валидатор остаётся только
 *     для hanging-piece).
 *   - Каждый drill валидируется через `TacticDrillSfValidatorService.validateOne`.
 *   - Между drill'ами — задержка ≥1с (1 позиция/сек, ADR §6.3 R5).
 *   - Lock-защита от перекрытий (`running`-флаг).
 *
 * ENV:
 *   - `TACTIC_DRILL_SF_VALIDATOR_ENABLED=1` — включить scheduler
 *     (default off; включается devops'ом после KS-2229 наполнения пула).
 *   - `TACTIC_DRILL_SF_VALIDATOR_BATCH=20` — сколько drill'ов
 *     обрабатывать за один tick (default 20; при 1с между ними —
 *     ~20 секунд cron-окна).
 *   - `TACTIC_DRILL_SF_THROTTLE_MS=1000` — задержка между позициями
 *     (default 1000 — «1 позиция/сек» по требованию задачи).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TacticDrillSfValidatorService } from './tactic-drill-sf-validator.service';

@Injectable()
export class TacticDrillSfValidatorScheduler {
  private readonly logger = new Logger(TacticDrillSfValidatorScheduler.name);
  private running = false;

  constructor(
    private readonly validator: TacticDrillSfValidatorService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async tick(): Promise<void> {
    if (process.env.TACTIC_DRILL_SF_VALIDATOR_ENABLED !== '1') {
      return;
    }
    if (this.running) {
      this.logger.warn('sf-validator tick skipped: previous still running');
      return;
    }

    this.running = true;
    try {
      const stats = await this.runOnce();
      this.logger.log(
        `sf-validator: processed=${stats.processed} ` +
          `accepted=${stats.accepted} rejected=${stats.rejected} ` +
          `errors=${stats.errors}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`sf-validator tick failed: ${msg}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Один tick: батч drill'ов, throttle между ними. Public для unit-тестов.
   */
  async runOnce(): Promise<{
    processed: number;
    accepted: number;
    rejected: number;
    errors: number;
  }> {
    const batchSize = parseEnvInt(
      process.env.TACTIC_DRILL_SF_VALIDATOR_BATCH,
      20,
    );
    const throttleMs = parseEnvInt(
      process.env.TACTIC_DRILL_SF_THROTTLE_MS,
      1000,
    );

    const drills = await this.validator.fetchUnvalidatedBatch(batchSize);
    let accepted = 0;
    let rejected = 0;
    let errors = 0;

    for (let i = 0; i < drills.length; i++) {
      const drill = drills[i];
      try {
        const v = await this.validator.validateOne(drill);
        if (v.accepted) accepted++;
        else rejected++;
      } catch (err) {
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `sf-validator drill=${drill.id} (${drill.type}) error: ${msg}`,
        );
      }
      // Throttle: 1 позиция/сек (между задачами; не перед первой и не
      // после последней).
      if (i < drills.length - 1 && throttleMs > 0) {
        await sleep(throttleMs);
      }
    }

    return { processed: drills.length, accepted, rejected, errors };
  }
}

function parseEnvInt(raw: string | undefined, def: number): number {
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
