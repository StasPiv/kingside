/**
 * Метрики воркера.
 *
 * Заложены интерфейсы и in-memory счётчики/гистограммы под ADR-013 §10.F.
 * Когда DevOps подключит `prom-client` (KS-1584), здесь же регистрируются
 * реальные Counter/Histogram из prom-client — потребителям (importer.ts,
 * position-indexer.ts) менять ничего не придётся.
 */

export interface CounterSample {
  labels: Record<string, string>;
  value: number;
}

export interface HistogramSample {
  labels: Record<string, string>;
  count: number;
  sum: number;
}

class Counter {
  private readonly samples = new Map<string, CounterSample>();

  constructor(readonly name: string, readonly help: string, readonly labelNames: string[]) {}

  inc(labels: Record<string, string>, value = 1): void {
    const key = this.keyOf(labels);
    const existing = this.samples.get(key);
    if (existing) existing.value += value;
    else this.samples.set(key, { labels: { ...labels }, value });
  }

  collect(): CounterSample[] {
    return [...this.samples.values()];
  }

  private keyOf(labels: Record<string, string>): string {
    return this.labelNames.map((n) => `${n}=${labels[n] ?? ''}`).join('|');
  }
}

class Histogram {
  private readonly samples = new Map<string, HistogramSample>();

  constructor(readonly name: string, readonly help: string, readonly labelNames: string[]) {}

  observe(labels: Record<string, string>, value: number): void {
    const key = this.keyOf(labels);
    const existing = this.samples.get(key);
    if (existing) {
      existing.count += 1;
      existing.sum += value;
    } else {
      this.samples.set(key, { labels: { ...labels }, count: 1, sum: value });
    }
  }

  /** Удобный хелпер для измерения длительности операции в секундах. */
  async time<T>(labels: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.observe(labels, (Date.now() - start) / 1000);
    }
  }

  collect(): HistogramSample[] {
    return [...this.samples.values()];
  }

  private keyOf(labels: Record<string, string>): string {
    return this.labelNames.map((n) => `${n}=${labels[n] ?? ''}`).join('|');
  }
}

export const archiveImportDurationSeconds = new Histogram(
  'archive_import_duration_seconds',
  'Длительность одного прохода импорта (секунды).',
  ['source'],
);

export const archiveImportGamesTotal = new Counter(
  'archive_import_games_total',
  'Счётчик обработанных партий по статусу (added/skipped/failed).',
  ['source', 'status'],
);

export const positionStatsUpsertDurationSeconds = new Histogram(
  'position_stats_upsert_duration_seconds',
  'Длительность batch UPSERT в position_stats (секунды).',
  ['source'],
);

/** Снапшот для интеграции с /metrics endpoint (будет подключён DevOps). */
export function snapshot(): {
  counters: Array<{ name: string; help: string; samples: CounterSample[] }>;
  histograms: Array<{ name: string; help: string; samples: HistogramSample[] }>;
} {
  return {
    counters: [
      { name: archiveImportGamesTotal.name, help: archiveImportGamesTotal.help, samples: archiveImportGamesTotal.collect() },
    ],
    histograms: [
      { name: archiveImportDurationSeconds.name, help: archiveImportDurationSeconds.help, samples: archiveImportDurationSeconds.collect() },
      { name: positionStatsUpsertDurationSeconds.name, help: positionStatsUpsertDurationSeconds.help, samples: positionStatsUpsertDurationSeconds.collect() },
    ],
  };
}
