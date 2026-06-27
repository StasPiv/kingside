/**
 * KS-4695 / ADR-147 §2.4 + §7A.1. Cron-обновление 3 matviews
 * `events.actor_event_counts_{24h,7d,30d}` через `REFRESH MATERIALIZED
 * VIEW CONCURRENTLY`.
 *
 * Расписание:
 *   - 24h — каждые **30 сек** (короткое окно, hot path для HintsEngine).
 *   - 7d  — каждые **5 минут**.
 *   - 30d — каждые **5 минут**.
 *
 * (ADR §7A.1: на стартовой ступени `db.t3.small` редкий refresh
 * длинных окон снижает eviction OLTP buffer pool. Когда поднимемся
 * до r5.large — расписание можно ужать.)
 *
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY` требует ownership на
 * matview — для этого используем `OwnerPrisma` (URL из
 * `EVENTS_DATABASE_URL`, обычно владелец БД), а не `WriterPrisma`
 * с минимальными правами.
 *
 * Метрика `matview_refresh_duration_seconds{view}` — histogram через
 * `EventsMetricsService.startMatviewRefresh(view)`.
 *
 * Если EventsPrismaService.getOwner() === null (нет EVENTS_DATABASE_URL,
 * локаль без events-infra) — сервис стартует, но cron-обработчики
 * раннеют в no-op (с warn в логи). Никаких таймеров не плодим.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import type { PrismaClient as EventsPrismaClient } from '@kingside/events-db';
import { EventsMetricsService } from './events-metrics.service';
import { EventsPrismaService } from './events-prisma.service';

@Injectable()
export class EventsRefreshService implements OnModuleInit {
  private readonly logger = new Logger(EventsRefreshService.name);
  private warnedNoOwner = false;

  constructor(
    private readonly prismaSvc: EventsPrismaService,
    private readonly metrics: EventsMetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.prismaSvc.getOwner()) {
      this.logger.warn(
        'EVENTS_DATABASE_URL не задан — matview refresh выключен (локальный dev).',
      );
    }
  }

  /** 30 сек для actor_event_counts_24h. */
  @Interval('events.refresh.24h', 30_000)
  async refresh24h(): Promise<void> {
    await this.refreshView('actor_event_counts_24h');
  }

  /** 5 мин для 7d и 30d через один cron, два последовательных вызова. */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'events.refresh.long' })
  async refreshLong(): Promise<void> {
    // Последовательно, не параллельно: один matview в данный момент,
    // чтобы не плодить параллельные REFRESH-операции и не съедать
    // shared_buffers.
    await this.refreshView('actor_event_counts_7d');
    await this.refreshView('actor_event_counts_30d');
  }

  private async refreshView(view: string): Promise<void> {
    const owner = this.prismaSvc.getOwner();
    if (!owner) {
      if (!this.warnedNoOwner) {
        this.warnedNoOwner = true;
        this.logger.warn(`refreshView ${view}: skip — EVENTS_DATABASE_URL не задан.`);
      }
      return;
    }
    const end = this.metrics.startMatviewRefresh(view);
    try {
      await this.execRefresh(owner, view);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // CONCURRENTLY валится если matview ещё ни разу не был
      // material'ed (создан через `WITH NO DATA` — наш случай в KS-4691).
      // Первый REFRESH делаем без CONCURRENTLY как fallback.
      if (msg.includes('CONCURRENTLY')) {
        this.logger.warn(`${view}: CONCURRENTLY rejected, falling back to non-concurrent: ${msg}`);
        try {
          await owner.$executeRawUnsafe(`REFRESH MATERIALIZED VIEW "events"."${view}"`);
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          this.logger.error(`${view}: fallback REFRESH failed: ${msg2}`);
        }
      } else {
        this.logger.error(`${view}: REFRESH CONCURRENTLY failed: ${msg}`);
      }
    } finally {
      end();
    }
  }

  private async execRefresh(owner: EventsPrismaClient, view: string): Promise<void> {
    // $executeRawUnsafe: view — известная константа из нашего кода,
    // не пользовательский input. SQL-injection-риска нет.
    await owner.$executeRawUnsafe(
      `REFRESH MATERIALIZED VIEW CONCURRENTLY "events"."${view}"`,
    );
  }
}
