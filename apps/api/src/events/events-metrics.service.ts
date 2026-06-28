/**
 * KS-4695 / ADR-147 §7A.2. Prometheus метрики для events / hints
 * pipeline. Регистрируются в общий `MetricsService.registry` — `/metrics`
 * scrape отдаёт их вместе со всеми остальными.
 *
 * Метрики:
 *   - actor_events_ingested_total{type, actor_type}  — counter XADD
 *   - actor_events_inserted_total{type, actor_type}  — counter ACK writer'а
 *   - actor_events_buffer_lag_seconds                — gauge: now() - ts(oldest PEL entry)
 *   - redis_stream_pending_entries{stream}           — gauge: XPENDING count
 *   - matview_refresh_duration_seconds{view}         — histogram REFRESH MV
 *   - guest_id_issued_total                          — counter: GuestIdMiddleware
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Gauge, Histogram } from 'prom-client';
import { MetricsService } from '../metrics/metrics.service';

@Injectable()
export class EventsMetricsService implements OnModuleInit {
  /** XADD в `actor_events:stream` (фактически принято на ingest). */
  readonly ingested: Counter<'type' | 'actor_type'>;

  /** Успешно записано в PG writer'ом и ACK'нуто в Stream. */
  readonly inserted: Counter<'type' | 'actor_type'>;

  /** Lag PEL: `now - ts(oldest pending message)`. >5s ≈ writer отстаёт. */
  readonly bufferLagSeconds: Gauge<string>;

  /** Размер PEL по consumer-group (XPENDING). */
  readonly streamPendingEntries: Gauge<'stream'>;

  /** Длительность одного REFRESH MV (любого из трёх matview). */
  readonly matviewRefreshDuration: Histogram<'view'>;

  /** GuestIdMiddleware успешно проставил `guest_id` (новый UUID). */
  readonly guestIdIssued: Counter<string>;

  /**
   * KS-4748 / ADR-149 G2: счётчик принятых внутренних событий по
   * `POST /internal/events` (game-service → apps/api). Растёт ровно
   * на успешный 202 (HMAC прошёл, payload валиден, EventsService.track
   * вызван). Метка `type` — тип события, как у `ingested`.
   *
   * Сравнение с `ingested_total{type}` за тот же интервал помогает
   * увидеть, какая доля событий идёт через internal-канал vs прямой
   * вызов `EventsService.track`.
   */
  readonly internalReceived: Counter<'type'>;

  constructor(private readonly metrics: MetricsService) {
    const registers = [this.metrics.registry];

    this.ingested = new Counter({
      name: 'actor_events_ingested_total',
      help: 'Количество событий, принятых API и положенных в Redis Stream '
        + 'actor_events:stream (XADD-успехи). Сравнение с inserted_total '
        + 'даёт текущий backlog writer\'а.',
      labelNames: ['type', 'actor_type'] as const,
      registers,
    });

    this.inserted = new Counter({
      name: 'actor_events_inserted_total',
      help: 'Количество событий, успешно записанных writer\'ом в PG '
        + 'и ACK\'нутых в Stream. ingested_total - inserted_total ≈ '
        + 'размер PEL (с учётом XACK race).',
      labelNames: ['type', 'actor_type'] as const,
      registers,
    });

    this.bufferLagSeconds = new Gauge({
      name: 'actor_events_buffer_lag_seconds',
      help: 'Возраст самой старой неподтверждённой записи в PEL '
        + 'consumer-group events-writer (секунды). Идёт через XPENDING '
        + 'idle. Алерт §7A.2: >5s — writer отстаёт; >60s — авария.',
      registers,
    });

    this.streamPendingEntries = new Gauge({
      name: 'redis_stream_pending_entries',
      help: 'Количество pending entries в consumer-group (XPENDING . count). '
        + 'Метка stream — имя стрима.',
      labelNames: ['stream'] as const,
      registers,
    });

    this.matviewRefreshDuration = new Histogram({
      name: 'matview_refresh_duration_seconds',
      help: 'Длительность REFRESH MATERIALIZED VIEW CONCURRENTLY для одного '
        + 'из counts-matview (24h/7d/30d). Алерт §7A.2: p95 >2s на 24h.',
      labelNames: ['view'] as const,
      // Бакеты: refresh 24h ожидаемо <1s, 7d/30d могут до 5s на целевой ступени.
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
      registers,
    });

    this.guestIdIssued = new Counter({
      name: 'guest_id_issued_total',
      help: 'Количество новых guest_id, выписанных GuestIdMiddleware. '
        + 'Не считает запросы с уже существующим валидным guest_id.',
      registers,
    });

    this.internalReceived = new Counter({
      name: 'internal_events_received_total',
      help: 'Количество событий, принятых через POST /internal/events '
        + '(game-service → apps/api, HMAC) и проброшенных в '
        + 'EventsService.track. Растёт на успешный 202; не учитывает '
        + '401/503/422.',
      labelNames: ['type'] as const,
      registers,
    });
  }

  onModuleInit(): void {
    // Все метрики уже зарегистрированы в конструкторе через `registers:`.
    // Хук reserved для будущей логики (например, периодический update gauge'ов).
  }

  /** Удобный хелпер для writer'а: один шаг ingest. */
  incIngested(type: string, actorType: 'user' | 'guest'): void {
    this.ingested.inc({ type, actor_type: actorType });
  }

  /** Удобный хелпер для writer'а: один шаг ACK. */
  incInserted(type: string, actorType: 'user' | 'guest', by = 1): void {
    this.inserted.inc({ type, actor_type: actorType }, by);
  }

  /** Сеттер для writer'а после XPENDING-проверки. */
  setBufferLag(seconds: number): void {
    this.bufferLagSeconds.set(seconds);
  }

  setStreamPending(stream: string, count: number): void {
    this.streamPendingEntries.set({ stream }, count);
  }

  /** Запись длительности refresh. Возвращает done() для wrap-style. */
  startMatviewRefresh(view: string): () => void {
    const end = this.matviewRefreshDuration.startTimer({ view });
    return end;
  }

  incGuestIdIssued(): void {
    this.guestIdIssued.inc();
  }

  incInternalReceived(type: string): void {
    this.internalReceived.inc({ type });
  }
}
