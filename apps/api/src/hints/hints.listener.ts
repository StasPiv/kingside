/**
 * KS-4699 / ADR-147 §4.1. Подписчик `EventsService.onTrack`,
 * который дёргает HintsService на ключевых событиях:
 *
 *   game_end, puzzle_failed, session_idle, page_view,
 *   guest_landing_viewed, guest_play_attempted
 *
 * Дополнительно — smart-dismiss observer (§5.1) для произвольных
 * событий (любой type), который может закрыть активные подсказки этого
 * actor'а, чей `acceptedBy` совпадает.
 *
 * Для guest-actor успешный результат checkFor (HintShowPayload) кладём
 * в `pending:<guest_id>` (Redis LIST, TTL 60 сек) — pull-эндпоинт T8
 * заберёт. Для user — payload отдаст T8 через WS gateway.
 *
 * **NB.** На T6 нет HTTP-транспорта для гостя (T8 ещё впереди). Pending-
 * Redis-список заполняется уже сейчас, чтобы при выкатке T8 фронт сразу
 * получал данные.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventsService } from '../events/events.service';
import { RedisService } from '../redis/redis.service';
import { HintsService } from './hints.service';
import type { Actor } from '../events/events.types';

/** События, на которые реактивно дёргаем HintsService.checkFor. */
const REACTIVE_TYPES = new Set<string>([
  'game_end',
  'puzzle_failed',
  'session_idle',
  'page_view',
  'guest_landing_viewed',
  'guest_play_attempted',
]);

const PENDING_TTL_SEC = 60;

@Injectable()
export class HintsListener implements OnModuleInit {
  private readonly logger = new Logger(HintsListener.name);

  constructor(
    private readonly events: EventsService,
    private readonly hints: HintsService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    this.events.onTrack((e) => this.handle(e.actor, e.type, e.payload));
  }

  private async handle(actor: Actor, type: string, payload: unknown): Promise<void> {
    // Smart-dismiss первым: даже на не-реактивных событиях может
    // сработать `acceptedBy` (например, puzzle_start от `acceptedBy:
    // [puzzle_start]` правила).
    void this.hints.handleSmartDismiss(actor, type).catch(() => undefined);

    if (!REACTIVE_TYPES.has(type)) return;
    // Контекст — минимальный. `page` приходит из payload.path для
    // page_view; для game/puzzle событий page-контекст не нужен (DSL
    // правила без page-предиката всё равно отработают).
    const ctxPage =
      typeof (payload as Record<string, unknown> | null)?.path === 'string'
        ? ((payload as Record<string, unknown>).path as string)
        : undefined;
    let result;
    try {
      result = await this.hints.checkFor(actor, {
        page: ctxPage,
        triggerEventType: type,
      });
    } catch (err) {
      this.logger.debug?.(`handle checkFor failed: ${(err as Error).message}`);
      return;
    }
    if (!result) return;
    // Для гостя кладём в pending-list. WS gateway-для user'а появится
    // в T8, тогда здесь будет аналогичный if (actor.type==='user') emit.
    if (actor.type === 'guest') {
      try {
        const key = `hints:pending:${actor.id}`;
        await this.redis.rpush(key, JSON.stringify(result));
        await this.redis.expire(key, PENDING_TTL_SEC);
      } catch (err) {
        this.logger.warn(`pending push failed: ${(err as Error).message}`);
      }
    }
  }
}
