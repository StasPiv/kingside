import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import type { ArchiveBucket } from '@kingside/shared';

/**
 * Центральный Prometheus registry для всего API.
 *
 * Отдельный `Registry` (а не `register` default из prom-client) — чтобы:
 *   1. В тестах можно было создавать чистый экземпляр без глобальных
 *      побочных эффектов (если понадобится).
 *   2. Логически собрать все метрики API в одном месте.
 *
 * Метрики:
 *   - archive_tree_list_mismatch_total{bucket}              — counter
 *   - archive_games_list_position_not_indexed_total{bucket} — counter
 *   - archive_tree_query_duration_seconds{cache_hit}        — histogram
 *   - archive_tree_cache_hit_ratio                          — gauge
 *
 * Также через `collectDefaultMetrics` собираются стандартные process-метрики
 * (event loop, память, fd) — они полезны для общего прод-мониторинга.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry: Registry;

  readonly archiveTreeListMismatchTotal: Counter<'bucket'>;
  readonly archiveGamesListPositionNotIndexedTotal: Counter<'bucket'>;
  readonly archiveTreeQueryDurationSeconds: Histogram<'cache_hit'>;
  readonly archiveTreeCacheHitRatio: Gauge<string>;

  constructor() {
    this.registry = new Registry();

    // Process-метрики (cpu, memory, event-loop). Делать это идемпотентно:
    // второй `collectDefaultMetrics` на тот же registry — no-op (prom-client
    // сам защищает), но лишние импорты не хочется тянуть.
    collectDefaultMetrics({ register: this.registry });

    this.archiveTreeListMismatchTotal = new Counter({
      name: 'archive_tree_list_mismatch_total',
      help:
        'Количество срабатываний fail-closed guard в /archive/games/by-position ' +
        '(items=[] && totalApprox>0). Инвариант #3 из ADR-016.',
      labelNames: ['bucket'] as const,
      registers: [this.registry],
    });

    this.archiveGamesListPositionNotIndexedTotal = new Counter({
      name: 'archive_games_list_position_not_indexed_total',
      help:
        'Количество запросов /archive/games/by-position, где позиция не ' +
        'индексирована в archive_game_positions (ply за пределами лимита).',
      labelNames: ['bucket'] as const,
      registers: [this.registry],
    });

    this.archiveTreeQueryDurationSeconds = new Histogram({
      name: 'archive_tree_query_duration_seconds',
      help: 'Длительность запроса /archive/tree и /archive/games/by-position в секундах.',
      labelNames: ['cache_hit'] as const,
      // Бакеты нацелены на типичные p50..p99 кэш-хитов (мс) и промахов
      // (сотни мс — SQL-путь). Если прод-профиль отклонится, скорректируем.
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });

    this.archiveTreeCacheHitRatio = new Gauge({
      name: 'archive_tree_cache_hit_ratio',
      help: 'Текущая доля cache-hit для archive-tree запросов [0..1].',
      registers: [this.registry],
    });
  }

  async onModuleInit(): Promise<void> {
    // Nothing async on boot — registry inited in constructor. Hook resrved
    // для будущего динамического enable/disable без рестарта.
  }

  /** Инкремент `archive_tree_list_mismatch_total{bucket}`. */
  incListMismatch(bucket: ArchiveBucket): void {
    this.archiveTreeListMismatchTotal.inc({ bucket });
  }

  /** Инкремент `archive_games_list_position_not_indexed_total{bucket}`. */
  incPositionNotIndexed(bucket: ArchiveBucket): void {
    this.archiveGamesListPositionNotIndexedTotal.inc({ bucket });
  }

  /** Запись длительности `archive_tree_query_duration_seconds{cache_hit}`. */
  observeTreeQueryDuration(cacheHit: boolean, durationSec: number): void {
    this.archiveTreeQueryDurationSeconds.observe(
      { cache_hit: cacheHit ? 'true' : 'false' },
      durationSec,
    );
  }

  /** Устанавливает текущий ratio (0..1). */
  setTreeCacheHitRatio(ratio: number): void {
    this.archiveTreeCacheHitRatio.set(ratio);
  }

  /**
   * Экспорт в Prometheus text-формате (`# HELP` / `# TYPE` / сэмплы).
   */
  async metrics(): Promise<string> {
    return this.registry.metrics();
  }

  /** Content-Type, который ожидает Prometheus scrape. */
  get contentType(): string {
    return this.registry.contentType;
  }
}
