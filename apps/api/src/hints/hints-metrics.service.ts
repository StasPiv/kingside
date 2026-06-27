/**
 * KS-4699 / ADR-147 §7A.2. Prometheus метрики HintsEngine.
 * Регистрируются в общий MetricsService.registry (как у events-pipeline).
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { MetricsService } from '../metrics/metrics.service';

@Injectable()
export class HintsMetricsService implements OnModuleInit {
  /** Длительность одного aggregate-запроса для DSL `count`. layer=matview|redis. */
  readonly aggregateQueryDuration: Histogram<'layer'>;
  /** Время выполнения HintsService.checkFor (все правила, до выбора winner). */
  readonly checkDuration: Histogram<'actor_type'>;
  /** hint показан (после успешной выдачи в transport — реактивная подсказка для T8). */
  readonly shown: Counter<'key' | 'actor_type'>;
  /** lifecycle 'acted' получен. */
  readonly acted: Counter<'key' | 'actor_type'>;
  /** lifecycle 'dismissed' получен. */
  readonly dismissed: Counter<'key' | 'actor_type'>;
  /** lifecycle 'ignored' получен (ttl истёк). */
  readonly ignored: Counter<'key' | 'actor_type'>;

  constructor(private readonly metrics: MetricsService) {
    const registers = [this.metrics.registry];
    this.aggregateQueryDuration = new Histogram({
      name: 'hints_aggregate_query_duration_seconds',
      help: 'Длительность aggregate-запроса HintsEngine (DSL count). '
        + 'layer=matview — SELECT из actor_event_counts_*; layer=redis — '
        + 'INCR/GET по hot counters agg:<actor_id>:<type>:<window>.',
      labelNames: ['layer'] as const,
      // matview p95 цель <50мс (ADR §2.4), redis p95 <5мс.
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
      registers,
    });
    this.checkDuration = new Histogram({
      name: 'hints_check_duration_seconds',
      help: 'Длительность HintsService.checkFor(actor, context) end-to-end '
        + '(включая загрузку правил, оценку DSL, выбор winner).',
      labelNames: ['actor_type'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
      registers,
    });
    this.shown = new Counter({
      name: 'hints_shown_total',
      help: 'Подсказка показана пользователю (lifecycle kind=shown).',
      labelNames: ['key', 'actor_type'] as const,
      registers,
    });
    this.acted = new Counter({
      name: 'hints_acted_total',
      help: 'CTA-клик или smart-dismiss (lifecycle kind=acted).',
      labelNames: ['key', 'actor_type'] as const,
      registers,
    });
    this.dismissed = new Counter({
      name: 'hints_dismissed_total',
      help: 'Пользователь нажал крестик (lifecycle kind=dismissed).',
      labelNames: ['key', 'actor_type'] as const,
      registers,
    });
    this.ignored = new Counter({
      name: 'hints_ignored_total',
      help: 'ttlSec истёк без действия (lifecycle kind=ignored).',
      labelNames: ['key', 'actor_type'] as const,
      registers,
    });
  }

  onModuleInit(): void {
    // Метрики зарегистрированы в конструкторе через `registers:`.
  }

  startCheck(actorType: 'user' | 'guest'): () => void {
    return this.checkDuration.startTimer({ actor_type: actorType });
  }
  startAggregateQuery(layer: 'matview' | 'redis'): () => void {
    return this.aggregateQueryDuration.startTimer({ layer });
  }
}
