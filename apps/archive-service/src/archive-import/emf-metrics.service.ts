import { Injectable, Logger } from '@nestjs/common';
import {
  createMetricsLogger,
  MetricsLogger,
  Unit,
  Configuration,
} from 'aws-embedded-metrics';
import type { TickResult, TickSourceResult } from './archive-import.service';

/**
 * Публикатор бизнес-метрик импортёра в CloudWatch через EMF (KS-1681,
 * ADR-020 §4).
 *
 * Почему EMF (embedded metric format), а не прямой PutMetricData:
 *   - short-lived ECS task писал бы в CloudWatch Metrics напрямую ~600ms
 *     на запрос (network + auth + parsing) и терял бы метрики на throttle;
 *   - EMF пишет JSON-строки в stdout, CloudWatch Logs сам парсит и
 *     экстрактит метрики → нулевой overhead на TPS-лимит.
 *
 * Namespace `Kingside/ArchiveImporter` (ADR-020 §4.1), dimensions:
 *   - `source` — код archive_sources.code (twic, и т.д.).
 *
 * Публикуемые метрики (из KS-1681):
 *   - GamesAdded            (Count, per-source)
 *   - GamesSkipped          (Count, per-source)
 *   - GamesParsed           (Count, per-source)
 *   - ImportDurationSeconds (Seconds, per-source)
 *   - SourcesFailed         (Count, per-source) — 1 если ImportResult.failed
 *     или throw; 0 иначе. В агрегате даёт CloudWatch alarm по любому
 *     непустому счётчику failure.
 *   - LastSuccessAgeSeconds (Seconds, per-source) — сколько секунд прошло
 *     с `archive_sources.last_success_at`; публикуется и для не-due
 *     источников, чтобы alarm «14 дней без импортов» срабатывал независимо
 *     от due-окна. Если lastSuccessAt=null (импорт ни разу не прошёл) —
 *     публикуется sentinel 10 лет в секундах (10*365*86400 = 315_360_000),
 *     чтобы alarm по threshold=1209600 (14 дней) тоже срабатывал.
 *
 * Каждый per-source вызов создаёт отдельный MetricsLogger (setDimensions),
 * потому что `aws-embedded-metrics` схлопнет putMetric с одинаковым
 * именем в одном контексте — а нам нужны разные значения по dimension.
 *
 * flush() обязателен: без `await logger.flush()` в short-lived процессе
 * EMF-записи могут не дойти до stdout.
 */

const NAMESPACE = 'Kingside/ArchiveImporter';
const NEVER_SUCCESS_AGE_SECONDS = 10 * 365 * 86400; // 10 лет, sentinel

@Injectable()
export class EmfMetricsPublisher {
  private readonly logger = new Logger(EmfMetricsPublisher.name);
  private readonly pending: MetricsLogger[] = [];

  constructor() {
    Configuration.namespace = NAMESPACE;
  }

  /**
   * Записывает метрики одного source-run. Не отправляет сразу — собирает
   * MetricsLogger'ы в `pending`, flush() отправит всё разом в конце
   * процесса.
   */
  recordSourceRun(run: TickSourceResult, now: Date = new Date()): void {
    const metrics = createMetricsLogger();
    metrics.setNamespace(NAMESPACE);
    metrics.setDimensions({ source: run.sourceCode });

    const parsed = run.result?.gamesParsed ?? 0;
    const added = run.result?.gamesAdded ?? 0;
    const skipped = run.result?.gamesSkipped ?? 0;

    metrics.putMetric('GamesAdded', added, Unit.Count);
    metrics.putMetric('GamesSkipped', skipped, Unit.Count);
    metrics.putMetric('GamesParsed', parsed, Unit.Count);
    metrics.putMetric(
      'ImportDurationSeconds',
      run.durationSec,
      Unit.Seconds,
    );

    // Failed=1 если tickOnce поймал throw ИЛИ если ImportResult.status==='failed'.
    // noop / lockHeld / partial — не считаются failure.
    const failed =
      run.error != null || run.result?.status === 'failed' ? 1 : 0;
    metrics.putMetric('SourcesFailed', failed, Unit.Count);

    metrics.putMetric(
      'LastSuccessAgeSeconds',
      this.computeLastSuccessAgeSeconds(run.lastSuccessAt, now),
      Unit.Seconds,
    );

    // Для отладки в CloudWatch Logs (не метрика, property).
    metrics.setProperty('due', run.due);
    metrics.setProperty('lockHeld', run.lockHeld);
    if (run.result) {
      metrics.setProperty('status', run.result.status);
      metrics.setProperty(
        'cursor',
        `${run.result.cursorBefore}→${run.result.cursorAfter}`,
      );
    }
    if (run.error) {
      metrics.setProperty('error', run.error);
    }

    this.pending.push(metrics);
  }

  /**
   * Записывает агрегат tickOnce — без dimensions, чтобы CloudWatch
   * видел суммарную активность процесса.
   */
  recordTickSummary(tick: TickResult): void {
    const metrics = createMetricsLogger();
    metrics.setNamespace(NAMESPACE);
    // Без dimensions — это агрегат за весь процесс.
    metrics.setDimensions({});
    metrics.putMetric('TickTotalGamesAdded', tick.totalGamesAdded, Unit.Count);
    metrics.putMetric('TickRunsTotal', tick.runs.length, Unit.Count);
    metrics.putMetric(
      'TickRunsFailed',
      tick.runs.filter(
        (r) => r.error != null || r.result?.status === 'failed',
      ).length,
      Unit.Count,
    );
    this.pending.push(metrics);
  }

  /**
   * Flush всех накопленных MetricsLogger'ов в stdout.
   *
   * Вызывается из importer-once.ts перед `process.exit(...)`. После flush
   * pending-очередь очищается, так что повторный вызов (на ошибке) не
   * задублирует метрики.
   */
  async flush(): Promise<void> {
    const items = this.pending.splice(0);
    if (items.length === 0) return;
    for (const m of items) {
      try {
        await m.flush();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`EMF flush failed: ${msg}`);
      }
    }
  }

  /**
   * Возраст последнего успеха в секундах. Если last_success_at=null —
   * возвращает sentinel (10 лет), чтобы CloudWatch alarm «N дней без
   * успеха» мог срабатывать и на новые источники, у которых ещё ни разу
   * не было успешного импорта.
   */
  private computeLastSuccessAgeSeconds(
    lastSuccessAt: Date | null,
    now: Date,
  ): number {
    if (!lastSuccessAt) return NEVER_SUCCESS_AGE_SECONDS;
    const diffMs = now.getTime() - lastSuccessAt.getTime();
    return Math.max(0, diffMs / 1000);
  }
}
