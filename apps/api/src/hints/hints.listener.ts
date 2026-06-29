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
/**
 * KS-4719: TTL last-page кэша. 5 минут — соответствует типичной длине
 * пользовательской сессии; за это окно реактивные события (game_end,
 * guest_landing_viewed, …) точно успеют пройти после page_view.
 */
const LAST_PAGE_TTL_SEC = 300;
const LAST_PAGE_KEY_PREFIX = 'hints:last-page:';

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
    // KS-4785: подтверждение в логах что listener реально подписался.
    // Если строки нет — HintsModule не инициализирован, и реактивная
    // ветка checkFor никогда не сработает.
    this.logger.log('onModuleInit: subscribed to EventsService.onTrack');
  }

  private async handle(actor: Actor, type: string, payload: unknown): Promise<void> {
    // Smart-dismiss первым: даже на не-реактивных событиях может
    // сработать `acceptedBy` (например, puzzle_start от `acceptedBy:
    // [puzzle_start]` правила).
    void this.hints.handleSmartDismiss(actor, type).catch(() => undefined);

    // KS-4719: на любом event'e с явным `path` или `page` в payload
    // сохраняем last-page в Redis. Эта запись используется как
    // fallback для типов событий, которые не несут page в payload
    // (`guest_landing_viewed`, `game_end`, ...). Без этого правила с
    // `page.matches='/'` никогда не сматчатся на гостевые ивенты.
    const explicitPage = readPayloadPage(payload);
    if (explicitPage) {
      try {
        await this.redis.set(
          `${LAST_PAGE_KEY_PREFIX}${actor.id}`,
          explicitPage,
          'EX',
          LAST_PAGE_TTL_SEC,
        );
      } catch (err) {
        this.logger.debug?.(`last-page cache set failed: ${(err as Error).message}`);
      }
    }

    if (!REACTIVE_TYPES.has(type)) return;

    // Контекст — payload.page / payload.path → fallback на Redis last-page.
    let ctxPage = explicitPage;
    if (!ctxPage) {
      try {
        const cached = await this.redis.get(`${LAST_PAGE_KEY_PREFIX}${actor.id}`);
        if (cached) ctxPage = cached;
      } catch { /* no-op */ }
    }

    let result;
    try {
      result = await this.hints.checkFor(actor, {
        page: ctxPage,
        triggerEventType: type,
      });
    } catch (err) {
      this.logger.warn(`handle checkFor failed actor=${actor.type}:${actor.id} type=${type}: ${(err as Error).message}`);
      return;
    }
    // KS-4719: диагностический лог. Тип события + actor + page +
    // результат (key выбранного hint либо 'no-match'). На проде это
    // даёт быстрое объяснение «почему гость не получил подсказку».
    this.logger.log(
      `checkFor actor=${actor.type}:${actor.id} type=${type} page=${ctxPage ?? '∅'} → ${result ? result.key : 'no-match'}`,
    );
    if (!result) return;
    // Для гостя кладём в pending-list. Для user — payload уже эмитнут
    // через WS gateway внутри HintsService.checkFor (KS-4701).
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

/** KS-4719: единый extract — поддержка `page` и `path` (разные хуки
 *  на фронте используют разное имя — usePageViewTracking шлёт `path`,
 *  useIdleTracking шлёт `page`). */
function readPayloadPage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.page === 'string' && p.page.length > 0) return p.page;
  if (typeof p.path === 'string' && p.path.length > 0) return p.path;
  return undefined;
}
