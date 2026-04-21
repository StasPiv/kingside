import { Injectable } from '@nestjs/common';
import type { ArchiveBucket } from '@kingside/shared';

/**
 * In-memory counters for archive tree queries.
 *
 * This is a lightweight placeholder until a real Prometheus collector
 * (prom-client) lands in the project. The public surface mirrors what
 * a future exporter would consume:
 *   - archive_tree_query_duration_seconds{cache_hit="true|false"}
 *   - archive_tree_cache_hit_ratio
 *   - archive_tree_list_mismatch_total{bucket}
 *
 * When prom-client is introduced, this service swaps to real Histograms
 * without changing its callers in {@link ArchiveService}.
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

  recordTreeQuery(cacheHit: boolean, durationSec: number): void {
    const label = cacheHit ? 'true' : 'false';
    this.durationSumByHit[label] += durationSec;
    this.durationCountByHit[label] += 1;
    if (cacheHit) {
      this.cacheHits += 1;
    } else {
      this.cacheMisses += 1;
    }
  }

  /**
   * Инкрементирует `archive_tree_list_mismatch_total{bucket}`. Вызывается
   * из guard'а в `ArchiveService.getGamesByPosition` при срабатывании
   * инварианта #3 (honest badge).
   */
  recordListMismatch(bucket: ArchiveBucket): void {
    this.listMismatchByBucket[bucket] += 1;
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
