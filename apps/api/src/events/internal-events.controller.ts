/**
 * KS-4748 / ADR-149 G2. Internal-эндпоинт `POST /internal/events` для
 * межпроцессного эмита actor-событий (game-service → apps/api).
 *
 * Гарантия: всё, что пришло на этот эндпоинт, проходит через
 * `EventsService.track`, поэтому in-memory подписчики (HintsEngine,
 * smart-dismiss observer) видят события из обоих процессов одинаково.
 *
 * Аутентификация — `InternalEventsGuard` (HMAC по `INTERNAL_EVENTS_SECRET`).
 * Без env-var endpoint отвечает 503 (см. guard).
 */
import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsMetricsService } from './events-metrics.service';
import { InternalEventsGuard } from './internal-events.guard';
import { InternalEventInputDto } from './dto/internal-event.dto';

@Controller('internal/events')
@UseGuards(InternalEventsGuard)
export class InternalEventsController {
  constructor(
    private readonly events: EventsService,
    private readonly metrics: EventsMetricsService,
  ) {}

  /**
   * 202 Accepted — событие принято и проброшено в `EventsService.track`.
   * Не дожидаемся завершения track (он сам fail-soft и не должен влиять
   * на response-time источника).
   */
  @Post()
  @HttpCode(202)
  async receive(@Body() body: InternalEventInputDto): Promise<{ ok: true }> {
    const occurredAt = body.ts ? new Date(body.ts) : undefined;
    await this.events.track(
      body.actor,
      body.type,
      body.payload ?? undefined,
      occurredAt ? { occurredAt } : undefined,
    );
    this.metrics.incInternalReceived(body.type);
    return { ok: true };
  }
}
