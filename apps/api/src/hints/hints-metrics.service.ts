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
  /** KS-4788 / ADR-151 §7. Replay-метрики (WS-handshake реплей подсказок). */
  readonly replayAttempts: Counter<'actor_type'>;
  readonly replayEmitted: Counter<'actor_type'>;
  readonly replaySkipped: Counter<'actor_type' | 'reason'>;
  /** KS-4788. Лаг между server-emit (`lastShownAt`) и client-ack (`shownAckAt`). */
  readonly shownAckLag: Histogram<'actor_type'>;
  /**
   * KS-4807 / ADR-153 §2.2. `emitHintShow` вызван, но Socket.IO room
   * `user:<id>` пуста (0 живых сокетов). payload дропнут, `lastShownAt`
   * уже записан выше → replay-on-connect (ADR-151) подхватит на
   * следующем handshake. Метрика — наблюдаемость, не блокировка.
   */
  readonly emitRoomEmpty: Counter<'actor_type'>;
  /**
   * KS-4807 / ADR-153 §2.2. Распределение размеров room `user:<id>` в
   * момент `emitHintShow`. Здоровое значение ≥1; нули → потери
   * live-доставки.
   */
  readonly emitRoomSize: Histogram<'actor_type'>;
  /**
   * KS-4808 / ADR-153 §2.3. Латентность от входа в `HintsListener.handle`
   * до возврата из `emitHintShow`. SLO: p95 ≤ 0.5s, p99 ≤ 1s. Превышение
   * — сигнал оптимизировать DSL (matview / Redis-counter, ADR-147 §2.4).
   */
  readonly reactiveEmitDuration: Histogram<'trigger_type'>;

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
    this.replayAttempts = new Counter({
      name: 'hints_replay_attempts_total',
      help: 'KS-4788. HintsService.replayPending() вызван (WS-handshake).',
      labelNames: ['actor_type'] as const,
      registers,
    });
    this.replayEmitted = new Counter({
      name: 'hints_replay_emitted_total',
      help: 'KS-4788. Replay вернул payload и он эмитнут в room user:<id>.',
      labelNames: ['actor_type'] as const,
      registers,
    });
    this.replaySkipped = new Counter({
      name: 'hints_replay_skipped_total',
      help: 'KS-4788. Replay не эмитил. reason ∈ {no_candidate, window_expired, '
        + 'already_acked, dismissed_or_acted, hint_disabled, killswitch_off, replay_off}.',
      labelNames: ['actor_type', 'reason'] as const,
      registers,
    });
    this.shownAckLag = new Histogram({
      name: 'hints_shown_ack_lag_seconds',
      help: 'KS-4788. Разница shownAckAt - lastShownAt на каждом /shown ack. '
        + 'Хвост >5s означает частый race на handshake.',
      labelNames: ['actor_type'] as const,
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
      registers,
    });
    this.emitRoomEmpty = new Counter({
      name: 'hints_emit_room_empty_total',
      help: 'KS-4807 / ADR-153 §2.2. emitHintShow вызван, но в Socket.IO '
        + 'room user:<id> 0 живых сокетов. payload дропнут, lastShownAt '
        + 'уже записан выше — replay-on-connect (ADR-151) подхватит на '
        + 'следующем handshake. Здоровое значение — стабильно <1% от '
        + 'общего числа emit\'ов.',
      labelNames: ['actor_type'] as const,
      registers,
    });
    this.emitRoomSize = new Histogram({
      name: 'hints_emit_room_size',
      help: 'KS-4807 / ADR-153 §2.2. Распределение размеров Socket.IO '
        + 'room user:<id> в момент emitHintShow. Здоровое значение ≥1; '
        + 'нули = потери live-доставки.',
      labelNames: ['actor_type'] as const,
      // Дискретные ёмкости: чаще всего 1 (одна вкладка), реже 2–3 (multi-tab).
      buckets: [0, 1, 2, 3, 5, 10],
      registers,
    });
    this.reactiveEmitDuration = new Histogram({
      name: 'hints_reactive_emit_duration_seconds',
      help: 'KS-4808 / ADR-153 §2.3. Латентность от HintsListener.handle '
        + '(входное событие) до возврата из emitHintShow. SLO: p95 ≤ 0.5s, '
        + 'p99 ≤ 1s. Превышение — сигнал оптимизировать DSL.',
      labelNames: ['trigger_type'] as const,
      // Согласно ADR §2.3.
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
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
