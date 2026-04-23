import { Injectable } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Prometheus-метрики sync-цикла (ADR-022 §2.5).
 *
 * Регистрируются в общем `MetricsService.registry` — `/_/metrics` отдаёт всё.
 *
 *  - `broadcast_sync_cycles_total{kind,result}` — счётчик тиков
 *    full/pinned-poll с результатом ok|err|skipped.
 *  - `broadcast_sync_duration_seconds{kind}` — длительность тика.
 *  - `broadcast_sync_failures_total{kind,reason}` — счётчик фейлов
 *    (отдельно, чтобы быстрее делать алерт без фильтра по label result).
 *
 * На шаге 0 сами счётчики увеличиваются только точечно — полное
 * инструментирование sync-цикла детализируем в follow-up-тасках. Здесь
 * гарантируем, что метрики зарегистрированы и экспортируются.
 */
@Injectable()
export class SyncMetricsService {
  readonly broadcastSyncCyclesTotal: Counter<'kind' | 'result'>;
  readonly broadcastSyncDurationSeconds: Histogram<'kind'>;
  readonly broadcastSyncFailuresTotal: Counter<'kind' | 'reason'>;
  /**
   * KS-1735 / ADR-023 §5.4. Покрытие chess-results URL'ами на каждой
   * `upsertBroadcast`-операции. Дешёвый сигнал «достаточно ли > 50% top-20
   * broadcasts имеют chess-results URL, чтобы фича оправдывала запуск».
   */
  readonly crosstableCoverageTotal: Counter<'status'>;
  /**
   * KS-1735 / ADR-023 §5.4. Hostname'ы сторонних standings-источников —
   * диагностика «какие популярные сайты закрывают остальной 50%, кандидаты
   * для будущих парсеров».
   */
  readonly crosstableUnsupportedSourceTotal: Counter<'host'>;

  constructor(metrics: MetricsService) {
    this.broadcastSyncCyclesTotal = new Counter({
      name: 'broadcast_sync_cycles_total',
      help: 'Количество завершённых циклов sync (full / pinned-poll).',
      labelNames: ['kind', 'result'] as const,
      registers: [metrics.registry],
    });

    this.broadcastSyncDurationSeconds = new Histogram({
      name: 'broadcast_sync_duration_seconds',
      help: 'Длительность одного тика sync в секундах.',
      labelNames: ['kind'] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
      registers: [metrics.registry],
    });

    this.broadcastSyncFailuresTotal = new Counter({
      name: 'broadcast_sync_failures_total',
      help: 'Количество фейлов в sync-цикле.',
      labelNames: ['kind', 'reason'] as const,
      registers: [metrics.registry],
    });

    this.crosstableCoverageTotal = new Counter({
      name: 'crosstable_coverage_total',
      help: 'Покрытие broadcast.standings_url chess-results-источником. ' +
        'matched=URL ведёт на chess-results.com (id извлечён); ' +
        'unsupported=URL есть, но другой домен; missing=URL пустой.',
      labelNames: ['status'] as const,
      registers: [metrics.registry],
    });

    this.crosstableUnsupportedSourceTotal = new Counter({
      name: 'crosstable_unsupported_source_total',
      help: 'Hostname сторонних standings-источников (для диагностики ' +
        'каких сайтов парсеры писать дальше). Кардинальность ограничена ' +
        'нормализацией: lower-case, www-префикс снят.',
      labelNames: ['host'] as const,
      registers: [metrics.registry],
    });
  }

  recordCycle(kind: 'full' | 'pinned', result: 'ok' | 'err' | 'skipped'): void {
    this.broadcastSyncCyclesTotal.inc({ kind, result });
  }

  observeDuration(kind: 'full' | 'pinned', durationSec: number): void {
    this.broadcastSyncDurationSeconds.observe({ kind }, durationSec);
  }

  recordFailure(kind: 'full' | 'pinned', reason: string): void {
    this.broadcastSyncFailuresTotal.inc({ kind, reason });
  }

  /**
   * Регистрирует одну `upsertBroadcast`-операцию в coverage-метрику.
   * `host` опционален — публикуется только для `unsupported` (см.
   * `crosstableUnsupportedSourceTotal`).
   */
  recordCrosstableCoverage(
    status: 'matched' | 'unsupported' | 'missing',
    host: string | null,
  ): void {
    this.crosstableCoverageTotal.inc({ status });
    if (status === 'unsupported' && host) {
      this.crosstableUnsupportedSourceTotal.inc({ host });
    }
  }
}
