import { Inject, Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram } from 'prom-client';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Importer-метрики на prom-client (ADR-019 §2.1 / §2.11).
 *
 * Имена метрик сохранены 1:1 относительно самописного `metrics.ts`
 * исторического archive-importer пакета (удалён по KS-1676) — Grafana/алерты
 * завязаны. Любое переименование должно сопровождаться миграцией dashboard'ов.
 *
 * Все Counter/Histogram/Gauge регистрируются в общий `MetricsService.registry`
 * archive-service — единая scrape-точка `/_/metrics`.
 */
@Injectable()
export class ArchiveImportMetricsService {
  readonly archiveImportDurationSeconds: Histogram<'source'>;
  readonly archiveImportGamesTotal: Counter<'source' | 'status'>;
  readonly positionStatsUpsertDurationSeconds: Histogram<'source'>;
  readonly archivePositionRowsCopyDurationSeconds: Histogram<'source'>;
  readonly archiveGamesByCategoryTotal: Counter<'source' | 'category'>;
  readonly archiveImportedNonClassicalTotal: Counter<'source'>;
  readonly archiveRejectedUnknownReasonTotal: Counter<'source' | 'rule'>;
  readonly archiveClassicalRatio: Gauge<'source'>;
  /** KS-2064: общее число игроков в `archive_players` (после backfill / sync). */
  readonly archivePlayersTotal: Gauge;
  /** KS-2064: общее число событий в `archive_events`. */
  readonly archiveEventsTotal: Gauge;

  constructor(
    @Inject(MetricsService) metricsService: MetricsService,
  ) {
    const registry = metricsService.registry;

    this.archiveImportDurationSeconds = new Histogram({
      name: 'archive_import_duration_seconds',
      help: 'Длительность одного прохода импорта (секунды).',
      labelNames: ['source'] as const,
      registers: [registry],
    });

    this.archiveImportGamesTotal = new Counter({
      name: 'archive_import_games_total',
      help: 'Счётчик обработанных партий по статусу (added/skipped/failed).',
      labelNames: ['source', 'status'] as const,
      registers: [registry],
    });

    this.positionStatsUpsertDurationSeconds = new Histogram({
      name: 'position_stats_upsert_duration_seconds',
      help: 'Длительность batch UPSERT в position_stats (секунды).',
      labelNames: ['source'] as const,
      registers: [registry],
    });

    this.archivePositionRowsCopyDurationSeconds = new Histogram({
      name: 'archive_importer_position_rows_copy_duration_seconds',
      help: 'Длительность batch COPY в archive_game_positions (секунды).',
      labelNames: ['source'] as const,
      registers: [registry],
    });

    this.archiveGamesByCategoryTotal = new Counter({
      name: 'archive_games_by_category_total',
      help: 'Счётчик импортированных партий, сгруппированных по классификации (classical, blitz, online-unknown, …).',
      labelNames: ['source', 'category'] as const,
      registers: [registry],
    });

    this.archiveImportedNonClassicalTotal = new Counter({
      name: 'archive_imported_non_classical_total',
      help: 'Счётчик не-классических партий, попавших в archive_games (в position_stats не пишутся).',
      labelNames: ['source'] as const,
      registers: [registry],
    });

    this.archiveRejectedUnknownReasonTotal = new Counter({
      name: 'archive_rejected_unknown_reason_total',
      help: 'Распределение по причинам вердикта classifyGame (blacklist_site, explicit_blitz_tc, legacy_otb, …).',
      labelNames: ['source', 'rule'] as const,
      registers: [registry],
    });

    this.archiveClassicalRatio = new Gauge({
      name: 'archive_classical_ratio',
      help: 'Доля classical (classical + classical-legacy) в последнем импортированном пакете источника [0..1].',
      labelNames: ['source'] as const,
      registers: [registry],
    });

    this.archivePlayersTotal = new Gauge({
      name: 'archive_players_total',
      help: 'Общее число строк в archive_players (KS-2064 / ADR-033 §4.4).',
      registers: [registry],
    });

    this.archiveEventsTotal = new Gauge({
      name: 'archive_events_total',
      help: 'Общее число строк в archive_events (KS-2064 / ADR-033 §4.4).',
      registers: [registry],
    });
  }

  /** Замер длительности одного import-прохода. */
  async timeImport<T>(source: string, fn: () => Promise<T>): Promise<T> {
    const end = this.archiveImportDurationSeconds.startTimer({ source });
    try {
      return await fn();
    } finally {
      end();
    }
  }

  /** Замер длительности batch UPSERT в position_stats. */
  async timePositionStatsUpsert<T>(source: string, fn: () => Promise<T>): Promise<T> {
    const end = this.positionStatsUpsertDurationSeconds.startTimer({ source });
    try {
      return await fn();
    } finally {
      end();
    }
  }

  /** Замер длительности batch COPY в archive_game_positions. */
  async timePositionRowsCopy<T>(source: string, fn: () => Promise<T>): Promise<T> {
    const end = this.archivePositionRowsCopyDurationSeconds.startTimer({ source });
    try {
      return await fn();
    } finally {
      end();
    }
  }
}
