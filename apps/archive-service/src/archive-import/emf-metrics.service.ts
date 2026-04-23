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
 * ADR-020 §2.5, §2.6).
 *
 * Почему EMF (embedded metric format), а не прямой PutMetricData:
 *   - short-lived ECS task писал бы в CloudWatch Metrics напрямую ~600ms
 *     на запрос (network + auth + parsing) и терял бы метрики на throttle;
 *   - EMF пишет JSON-строки в stdout, CloudWatch Logs сам парсит и
 *     экстрактит метрики → нулевой overhead на TPS-лимит.
 *
 * ‼️ Sink-режим (stdout vs TCP к EMF Agent `0.0.0.0:25888`) выбирается
 * по env `AWS_EMF_ENVIRONMENT`. По умолчанию `aws-embedded-metrics`
 * пытается подключиться к EMF Agent — на Fargate без sidecar'а это
 * даёт `ECONNREFUSED` и метрики в CloudWatch не попадают. Для Fargate +
 * awslogs driver нужен Local-режим (stdout); env выставляется в
 * `src/setup-emf-env.ts` side-effect-ом ДО загрузки этой библиотеки.
 * НЕ УДАЛЯЙ `./setup-emf-env` импорт из `importer-once.ts` — иначе
 * ECS RunTask будет молча терять метрики (ADR-020 §2.5, KS-1682 блокер).
 *
 * Namespace `Kingside/ArchiveImporter` (ADR-020 §2.5).
 *
 * Catalog-level per-source метрики (dimension `source`, эмитятся через
 * `recordCatalogAge()` для **каждого** enabled-источника из `archive_sources`,
 * независимо от того, запускался ли runSource на этом тике):
 *   - `LastSuccessAgeSeconds`  (Seconds) — возраст успеха с `last_success_at`.
 *      Если `last_success_at=null` (импорт ни разу не проходил) — sentinel
 *      10 лет в секундах (10*365*86400), alarm A4 с threshold=1209600
 *      (14 дней) сработает. KS-1716: метрика ДОЛЖНА публиковаться даже
 *      когда `tick.runs===[]` (все источники не-due), иначе alarm A4
 *      застревает в `INSUFFICIENT_DATA/ALARM` из-за отсутствия datapoints.
 *      Логически это мониторинг каталога, а не итог конкретного тика.
 *
 * Run-level per-source метрики (dimension `source`, эмитятся через
 * `recordSourceRun()` только для источников, по которым состоялся runSource
 * — due и не заблокированы):
 *   - `GamesAdded`             (Count)
 *   - `GamesSkipped`           (Count)
 *   - `GamesParsed`            (Count)
 *   - `ImportDurationSeconds`  (Seconds)
 *   - `SourcesFailed`          (Count, 0/1) — per-source флаг failure,
 *      нужен для CloudWatch Alarm A3 (`SourcesFailed > 0 за 1 ч`,
 *      дифф по dimension'у `source`). ADR-020 §2.7.
 *   - `ClassicalRatio`         (None, 0..1) — доля classical-партий среди
 *      добавленных. Публикуется ТОЛЬКО если `ImportResult.classicalRatio`
 *      определён (status in 'ok'|'partial' и gamesAdded>0) — иначе
 *      no-op и failed tick'и искажали бы ratio нулями. ADR-020 §2.5.
 *
 * Tick-агрегаты (без dimensions, один EMF record на весь процесс,
 * ADR-020 §2.5 пример):
 *   - `SourcesChecked`   (Count) — сколько enabled-источников перебрал
 *      tickOnce (includes not-due / locked / failed).
 *   - `SourcesProcessed` (Count) — сколько реально запустил runSource
 *      (`due=true && !lockHeld`) — неважно, успех или fail.
 *   - `SourcesFailed`    (Count) — сколько источников упало (throw или
 *      `ImportResult.status==='failed'`).
 *   - `TotalGamesAdded`  (Count) — сумма gamesAdded по всем runs.
 *   - `ExitCode`         (None, 0/1/2/124) — итоговый exit code, дублирует
 *      exit status для CloudWatch-аналитики (чтобы alarm по exitCode
 *      работал без `ECS Task State Change` EventBridge-rule).
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

/**
 * Запись каталога для `recordCatalogAge()`: минимально необходимое
 * подмножество `archive_sources` (`code` + `last_success_at`). Не привязано
 * к `TickSourceResult`, чтобы catalog-emit работал даже когда tickOnce
 * не стартовал (bootstrap fail, timeout до processAll).
 */
export interface ArchiveSourceCatalogEntry {
  code: string;
  lastSuccessAt: Date | null;
}

@Injectable()
export class EmfMetricsPublisher {
  private readonly logger = new Logger(EmfMetricsPublisher.name);
  private readonly pending: MetricsLogger[] = [];

  constructor() {
    Configuration.namespace = NAMESPACE;
  }

  /**
   * Записывает run-level метрики одного source-run (GamesAdded, ImportDuration,
   * ClassicalRatio, per-source SourcesFailed). Не отправляет сразу — собирает
   * MetricsLogger'ы в `pending`, flush() отправит всё разом в конце
   * процесса.
   *
   * `LastSuccessAgeSeconds` здесь НЕ эмитится — это catalog-level метрика,
   * публикуется через `recordCatalogAge()` для всех enabled источников,
   * независимо от того, был ли runSource на этом тике (KS-1716).
   */
  recordSourceRun(run: TickSourceResult): void {
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

    // ClassicalRatio публикуется только при реальном импорте с добавленными
    // играми. Для noop/failed/lockHeld classicalRatio=undefined — не пишем,
    // чтобы пустые tick'и не затирали CloudWatch gauge нулями.
    if (run.result?.classicalRatio !== undefined) {
      metrics.putMetric(
        'ClassicalRatio',
        run.result.classicalRatio,
        Unit.None,
      );
    }

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
   * Публикует `LastSuccessAgeSeconds{source=<code>}` для каждого источника
   * каталога (KS-1716, ADR-020 §2.6).
   *
   * Вызывается в `importer-once.ts` ПОСЛЕ `seed.ensureDefaults()` и не
   * зависит от `tick.runs` — каталог-метрика должна публиковаться даже
   * если `tickOnce()` не нашёл ни одного due-источника или упал до
   * `processAll`. Без этого CloudWatch alarm A4 «14 дней без успеха»
   * застревает в `ALARM/INSUFFICIENT_DATA`, потому что метрика просто
   * не поступает.
   *
   * Каждая запись — отдельный MetricsLogger с dimension `source=code`,
   * чтобы CloudWatch не схлопывал значения по одной и той же метрике
   * в одном контексте.
   *
   * Если `lastSuccessAt=null` — sentinel 10 лет в секундах, alarm с
   * threshold=1209600 (14 дней) сработает на новом источнике, которого
   * ни разу не удалось импортнуть.
   */
  recordCatalogAge(
    entries: ReadonlyArray<ArchiveSourceCatalogEntry>,
    now: Date = new Date(),
  ): void {
    for (const entry of entries) {
      const metrics = createMetricsLogger();
      metrics.setNamespace(NAMESPACE);
      metrics.setDimensions({ source: entry.code });
      metrics.putMetric(
        'LastSuccessAgeSeconds',
        this.computeLastSuccessAgeSeconds(entry.lastSuccessAt, now),
        Unit.Seconds,
      );
      // Property для CloudWatch Logs — удобно фильтровать «ни разу не
      // успевал» источники.
      metrics.setProperty(
        'lastSuccessAt',
        entry.lastSuccessAt ? entry.lastSuccessAt.toISOString() : null,
      );
      this.pending.push(metrics);
    }
  }

  /**
   * Записывает агрегат tickOnce — без dimensions, чтобы CloudWatch
   * видел суммарную активность процесса (ADR-020 §2.5 пример EMF).
   *
   * `exitCode` — финальный exit status процесса (0 / 2 / 124 / 1),
   * публикуется как отдельная метрика для CloudWatch Alarm'ов, которые
   * не хотят зависеть от `ECS Task State Change` EventBridge-rule.
   */
  recordTickSummary(tick: TickResult, exitCode: number = 0): void {
    const metrics = createMetricsLogger();
    metrics.setNamespace(NAMESPACE);
    // Без dimensions — это агрегат за весь процесс.
    metrics.setDimensions({});

    const sourcesChecked = tick.runs.length;
    const sourcesProcessed = tick.runs.filter(
      (r) => r.due && !r.lockHeld,
    ).length;
    const sourcesFailed = tick.runs.filter(
      (r) => r.error != null || r.result?.status === 'failed',
    ).length;

    metrics.putMetric('SourcesChecked', sourcesChecked, Unit.Count);
    metrics.putMetric('SourcesProcessed', sourcesProcessed, Unit.Count);
    metrics.putMetric('SourcesFailed', sourcesFailed, Unit.Count);
    metrics.putMetric('TotalGamesAdded', tick.totalGamesAdded, Unit.Count);
    metrics.putMetric('ExitCode', exitCode, Unit.None);

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
