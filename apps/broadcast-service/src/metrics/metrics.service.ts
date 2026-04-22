import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Prometheus registry broadcast-service.
 *
 * Метрики:
 *   - broadcast_ws_connections                 — gauge (текущие ws клиенты)
 *   - broadcast_ws_subscribe_total{round}      — counter (подписки на раунды)
 *   - broadcast_redis_message_total{channel}   — counter (сообщения из Redis pub/sub)
 *   - broadcast_http_query_duration_seconds    — histogram (длительность HTTP)
 *
 * Отдельный `Registry` (а не default) — чтобы в тестах можно было создавать
 * чистый экземпляр без глобальных побочных эффектов.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry: Registry;

  readonly broadcastWsConnections: Gauge<string>;
  readonly broadcastWsSubscribeTotal: Counter<'round'>;
  readonly broadcastRedisMessageTotal: Counter<'channel'>;
  readonly broadcastHttpQueryDurationSeconds: Histogram<'route'>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

    this.broadcastWsConnections = new Gauge({
      name: 'broadcast_ws_connections',
      help: 'Текущее количество подключённых клиентов к `/broadcast` namespace.',
      registers: [this.registry],
    });

    this.broadcastWsSubscribeTotal = new Counter({
      name: 'broadcast_ws_subscribe_total',
      help: 'Количество подписок на комнаты `broadcast:{roundId}`.',
      labelNames: ['round'] as const,
      registers: [this.registry],
    });

    this.broadcastRedisMessageTotal = new Counter({
      name: 'broadcast_redis_message_total',
      help: 'Количество сообщений, полученных из Redis pub/sub (от worker).',
      labelNames: ['channel'] as const,
      registers: [this.registry],
    });

    this.broadcastHttpQueryDurationSeconds = new Histogram({
      name: 'broadcast_http_query_duration_seconds',
      help: 'Длительность HTTP-запросов к broadcasts endpoints в секундах.',
      labelNames: ['route'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
  }

  async onModuleInit(): Promise<void> {
    // Nothing async on boot — registry inited in constructor.
  }

  incWsConnection(): void {
    this.broadcastWsConnections.inc();
  }

  decWsConnection(): void {
    this.broadcastWsConnections.dec();
  }

  incSubscribe(roundId: string): void {
    this.broadcastWsSubscribeTotal.inc({ round: roundId });
  }

  incRedisMessage(channel: string): void {
    this.broadcastRedisMessageTotal.inc({ channel });
  }

  observeHttpDuration(route: string, durationSec: number): void {
    this.broadcastHttpQueryDurationSeconds.observe({ route }, durationSec);
  }

  async metrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
