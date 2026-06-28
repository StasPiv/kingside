/**
 * KS-4695 / ADR-147 §2.2 + §6.2 + §2.4. Single-entry-point для трекинга
 * actor-событий. Дёргается:
 *
 *   - HTTP `POST /events` (EventsController, batch до 50);
 *   - backend self-emit (game/puzzle/lessons и т.д. — T3, KS-4696,
 *     вне scope этой задачи), через прямой DI EventsService.
 *
 * Контракт `track`:
 *   1. Гейт по `analytics_consent`:
 *      - user → читаем `User.analyticsConsent` (default false → events
 *        отбрасываются на входе, ADR §6.2).
 *      - guest → факт согласия валидируется до middleware (без cookie
 *        `analytics_consent_sig` GuestIdMiddleware не выставляет
 *        `guest_id`; следовательно сюда guest-actor попадает только
 *        после прохождения подписи).
 *   2. `XADD actor_events:stream * type=<…> actor_id=<…> actor_type=<…>
 *      payload=<json>` с `MAXLEN ~ 50000`.
 *   3. Метрика `actor_events_ingested_total{type, actor_type}` ++.
 *
 * Если Redis недоступен — track НЕ бросает наружу: trackingfailure не
 * должен ломать business-flow вызывающего сервиса. Ошибка пишется в
 * логи (rate-limited через @nestjs Logger).
 *
 * Если EventsPrismaService.getWriter() === null (EVENTS_* env не заданы,
 * локаль) — track всё равно работает (XADD в Redis), просто writer
 * не сольёт в PG. Это правильно: контракт track — «событие принято в
 * pipeline», PG — деталь следующего шага.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { EventsMetricsService } from './events-metrics.service';
import {
  ACTOR_EVENTS_MAXLEN,
  ACTOR_EVENTS_STREAM,
  Actor,
} from './events.types';

export type EventPayload = Record<string, unknown> | null | undefined;

/**
 * KS-4699 / ADR-147 §4.1 п.1: подписчик `track` — для HintsEngine,
 * чтобы реактивно проверять правила после ключевых событий
 * (`game_end`, `puzzle_failed`, `page_view`, ...). И параллельно —
 * smart-dismiss observer (§5.1). Подписка in-memory, без зависимости
 * от @nestjs/event-emitter — модулю достаточно одного listener.
 */
export interface TrackEvent {
  actor: Actor;
  type: string;
  payload: EventPayload;
  occurredAt: Date;
}
export type TrackListener = (e: TrackEvent) => void | Promise<void>;

interface TrackOptions {
  /**
   * Время на клиенте, если есть (`ts` из payload фронта). Если не
   * задано — берётся серверное `now()`. Используется в Stream'е как
   * исходный момент события (writer кладёт в `created_at`).
   */
  occurredAt?: Date;
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  /**
   * Простой in-memory кэш `userId → analyticsConsent` с TTL 60 сек.
   * Read-path: один SELECT на каждый track — недопустимо. Согласие
   * меняется редко (manually через банер), 60 сек — допустимое окно
   * (ADR §6.2 не требует мгновенной отмены — отзыв трекается через
   * unmount страницы, событие в очереди уже принято).
   */
  private readonly consentCache = new Map<
    string,
    { value: boolean; expiresAt: number }
  >();
  private readonly CONSENT_CACHE_TTL_MS = 60_000;

  /** KS-4699: подписчики in-memory. Каждый track успешно прошёл XADD
   *  → вызываем всех listener'ов (fire-and-forget, ошибки логируются). */
  private readonly trackListeners: TrackListener[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: EventsMetricsService,
  ) {}

  /** KS-4699: HintsModule подписывается в onModuleInit. */
  onTrack(listener: TrackListener): void {
    this.trackListeners.push(listener);
  }

  /**
   * Главный entry-point.
   *
   * @returns `true` — событие принято в pipeline (`XADD` успешен).
   *          `false` — отброшено по consent или из-за Redis-сбоя.
   *          Бросать наружу не должен.
   */
  async track(
    actor: Actor,
    type: string,
    payload: EventPayload,
    opts: TrackOptions = {},
  ): Promise<boolean> {
    if (!isValidActor(actor) || !isValidType(type)) {
      this.logger.warn(
        `track: skip — invalid actor or type (actor.type=${String(actor?.type)}, type=${String(type)})`,
      );
      return false;
    }

    // Гейт consent для user. Для guest consent уже проверен middleware'ом
    // (без cookie-подписи нет guest_id, см. GuestIdMiddleware).
    // KS-4760: bypass под NODE_ENV=test + ANALYTICS_CONSENT_BYPASS=1 —
    // единая точка с `hasConsent` (избегаем расхождения).
    if (actor.type === 'user' && !isConsentBypass()) {
      const ok = await this.hasUserConsent(actor.id);
      if (!ok) return false;
    }

    const payloadJson = serializePayload(payload);
    const occurredAt = (opts.occurredAt ?? new Date()).toISOString();

    try {
      // XADD stream MAXLEN ~ N * type type actor_id id actor_type t payload p ts ts
      // ~ MAXLEN — approximate trim (Redis может удалять блоками для O(1)
      // вместо точного по одному элементу).
      await this.redis.xadd(
        ACTOR_EVENTS_STREAM,
        'MAXLEN',
        '~',
        ACTOR_EVENTS_MAXLEN,
        '*',
        'type',
        type,
        'actor_id',
        actor.id,
        'actor_type',
        actor.type,
        'payload',
        payloadJson,
        'occurred_at',
        occurredAt,
      );
      this.metrics.incIngested(type, actor.type);
      // KS-4699: notify in-memory listeners (HintsEngine — реактивный
      // check + smart-dismiss observer). Каждый listener — fire-and-forget,
      // ошибки не должны ломать ingest.
      const evt: TrackEvent = {
        actor,
        type,
        payload: payload ?? null,
        occurredAt: opts.occurredAt ?? new Date(),
      };
      for (const l of this.trackListeners) {
        try {
          const r = l(evt);
          if (r && typeof (r as Promise<void>).catch === 'function') {
            (r as Promise<void>).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              this.logger.warn(`trackListener failed: ${msg}`);
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`trackListener threw: ${msg}`);
        }
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`track: XADD failed (type=${type}, actor=${actor.type}): ${msg}`);
      return false;
    }
  }

  /**
   * KS-4699: гейт по analytics_consent для actor'а. Использует тот же
   * TTL-кэш, что `track`. HintsService переиспользует этот метод
   * вместо дублирования логики (без рефакторинга на отдельный сервис —
   * `track` и `checkFor` всегда вместе).
   *
   * KS-4760 / ADR-150 T2: под `NODE_ENV=test` И `ANALYTICS_CONSENT_BYPASS=1`
   * возвращает true для любого user — нужно e2e сценариям, где fixture
   * user не имеет реального `analyticsConsent=true` в БД. Обе проверки
   * — env-var'ы; на проде ни одно из двух не задано.
   */
  async hasConsent(actor: Actor): Promise<boolean> {
    if (actor.type === 'guest') {
      // Guest сюда попадает только после прохождения подписанного
      // analytics_consent cookie (см. GuestIdMiddleware). Дополнительно
      // проверять нечего.
      return true;
    }
    if (isConsentBypass()) return true;
    return this.hasUserConsent(actor.id);
  }

  /**
   * Чтение `User.analyticsConsent` с локальным кэшем.
   * При ошибке БД — fail-closed: возвращаем `false`, событие отбрасывается.
   */
  private async hasUserConsent(userId: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.consentCache.get(userId);
    if (cached && cached.expiresAt > now) return cached.value;

    try {
      const row = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { analyticsConsent: true },
      });
      const value = Boolean(row?.analyticsConsent);
      this.consentCache.set(userId, {
        value,
        expiresAt: now + this.CONSENT_CACHE_TTL_MS,
      });
      return value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`hasUserConsent: DB error for ${userId}, fail-closed: ${msg}`);
      return false;
    }
  }

  /** Тест-хелпер: сброс кэша согласий (имитация обновления). */
  invalidateConsentCache(userId?: string): void {
    if (userId) {
      this.consentCache.delete(userId);
    } else {
      this.consentCache.clear();
    }
  }
}

/**
 * KS-4760 / ADR-150 T2. Bypass проверки analytics_consent под
 * `NODE_ENV=test` + `ANALYTICS_CONSENT_BYPASS=1`. Используется только
 * e2e-сценариями hints. На проде ни одно из двух условий не выполнено.
 */
function isConsentBypass(): boolean {
  return (
    process.env.NODE_ENV === 'test'
    && process.env.ANALYTICS_CONSENT_BYPASS === '1'
  );
}

/* ---------------------------------------------------------------- */

function isValidActor(actor: Actor | undefined): actor is Actor {
  if (!actor) return false;
  if (actor.type !== 'user' && actor.type !== 'guest') return false;
  if (typeof actor.id !== 'string' || actor.id.length === 0) return false;
  return true;
}

function isValidType(type: string): boolean {
  // 1..64 символа, как в schema.prisma `@db.VarChar(64)`. Защита от
  // случайных мусорных строк и от reserved-имён писать не нужно —
  // используются прикладным кодом, не пользователем.
  return typeof type === 'string' && type.length > 0 && type.length <= 64;
}

function serializePayload(payload: EventPayload): string {
  if (payload === undefined || payload === null) return '{}';
  try {
    return JSON.stringify(payload);
  } catch {
    // Циклы / BigInt — кладём пустой объект, чтобы writer не сломался.
    return '{}';
  }
}
