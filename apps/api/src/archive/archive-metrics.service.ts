import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ArchiveBucket } from '@kingside/shared';
import { MetricsService } from '../metrics/metrics.service';

/**
 * In-memory counters for archive tree queries.
 *
 * Делает две вещи одновременно:
 *   1. Держит локальный snapshot (`cacheHits`, `cacheMisses`,
 *      `listMismatchByBucket`, ...) — используется в существующих unit-тестах
 *      и может сохраниться для быстрых `/archive/...` админ-дашбордов без
 *      похода в Prometheus.
 *   2. Если в DI доступен `MetricsService` (prom-client registry,
 *      KS-1637) — пробрасывает те же события в глобальные
 *      counter/histogram/gauge, чтобы `/api/metrics` экспонировал их.
 *
 * `MetricsService` помечен `@Optional()`: тесты (`archive.service.spec`,
 * `archive-metrics.service.spec`) собирают сервис вручную без глобального
 * модуля — и тогда prom-client просто не тикает, а snapshot'ы работают.
 */
@Injectable()
export class ArchiveMetricsService {
  private cacheHits = 0;
  private cacheMisses = 0;
  /** Duration totals in seconds, bucketed by cache_hit label. */
  private durationSumByHit: Record<'true' | 'false', number> = { true: 0, false: 0 };
  private durationCountByHit: Record<'true' | 'false', number> = { true: 0, false: 0 };

  /**
   * Счётчик несоответствий между дeревом и списком партий:
   * `items.length === 0 && totalApprox > 0` (ADR-016 §Инвариант #3).
   * Должен быть ≈ 0 после завершения backfill. Пока ply-индексы
   * синхронизируются — ожидается шумовой уровень, который падает по мере
   * прогрева `archive_game_positions`.
   */
  private listMismatchByBucket: Record<ArchiveBucket, number> = {
    master: 0,
    user: 0,
  };

  /**
   * KS-1639: ОБЯЗАТЕЛЬНО явно указать токен через `@Inject(MetricsService)`.
   * TypeScript `emitDecoratorMetadata` для union-типа (`MetricsService | null`)
   * сериализует runtime-metadata как `Object` — Nest DI не распознаёт токен,
   * и `@Optional()` подставляет `undefined` / default `null`. Итог: на проде
   * `this.prom === null` всегда, все `recordTreeQuery`/`recordListMismatch`
   * вызовы prom-client становятся no-op, метрики не инкрементятся.
   * См. https://github.com/nestjs/nest/issues/1083 — известная ловушка.
   */
  constructor(
    @Optional()
    @Inject(MetricsService)
    private readonly prom: MetricsService | null = null,
  ) {}

  recordTreeQuery(cacheHit: boolean, durationSec: number): void {
    const label = cacheHit ? 'true' : 'false';
    this.durationSumByHit[label] += durationSec;
    this.durationCountByHit[label] += 1;
    if (cacheHit) {
      this.cacheHits += 1;
    } else {
      this.cacheMisses += 1;
    }

    if (this.prom) {
      this.prom.observeTreeQueryDuration(cacheHit, durationSec);
      const total = this.cacheHits + this.cacheMisses;
      if (total > 0) {
        this.prom.setTreeCacheHitRatio(this.cacheHits / total);
      }
    }
  }

  /**
   * Инкрементирует `archive_tree_list_mismatch_total{bucket}`. Вызывается
   * из guard'а в `ArchiveService.getGamesByPosition` при срабатывании
   * инварианта #3 (honest badge).
   */
  recordListMismatch(bucket: ArchiveBucket): void {
    this.listMismatchByBucket[bucket] += 1;
    this.prom?.incListMismatch(bucket);
  }

  /** Snapshot of current counters — used in tests and future /metrics exporter. */
  snapshot() {
    const total = this.cacheHits + this.cacheMisses;
    return {
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cacheHitRatio: total === 0 ? 0 : this.cacheHits / total,
      durationSumByHit: { ...this.durationSumByHit },
      durationCountByHit: { ...this.durationCountByHit },
      listMismatchByBucket: { ...this.listMismatchByBucket },
    };
  }
}
