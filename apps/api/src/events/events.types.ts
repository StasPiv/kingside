/**
 * KS-4695 / ADR-147 §2.2, §6.2. Внутренние типы EventsModule. Не
 * экспортируются за пределы `apps/api/src/events/` (shared-контракты
 * лежат в `packages/shared`). Здесь — то, что нужно внутри модуля и
 * соседним сервисам через DI EventsService.
 */

/**
 * Actor — обобщённая категория «кто породил событие». Различает
 * авторизованного пользователя и гостя (с подписанным cookie
 * `guest_id`).
 *
 * Контракт ADR-147 §1.1: `actor.id` — UUID; для user это `user.id`,
 * для guest — UUID, сгенерированный `GuestIdMiddleware`.
 */
export type ActorType = 'user' | 'guest';

export interface Actor {
  type: ActorType;
  /** UUID. */
  id: string;
}

/** Единое имя Redis Stream (см. ADR §2.2). */
export const ACTOR_EVENTS_STREAM = 'actor_events:stream';

/** Имя consumer-group для writer'ов (см. ADR §2.2 пункт «consumer groups + ACK»). */
export const EVENTS_WRITER_GROUP = 'events-writer';

/**
 * MAXLEN ~N для XADD — мягкий лимит длины стрима. Защита от bloat'а
 * при простое writer'а. ADR §2.2 «MAXLEN ~ N» (~ — approximate, чтобы
 * Redis мог удалять кратно блокам O(1), а не строго по одному).
 *
 * 50K = ~50 секунд ingest при пиковой скорости 1K/sec (§2.4).
 */
export const ACTOR_EVENTS_MAXLEN = 50_000;

/**
 * Имя cookie с согласием на трекинг analytics. Значение — `1` либо
 * отсутствует. Подпись хранится в отдельном cookie `analytics_consent_sig`,
 * чтобы фронт мог читать само значение без знания серверного секрета
 * (см. ADR-147 §6.2, frontend `readAnalyticsConsentCookie()`).
 */
export const ANALYTICS_CONSENT_COOKIE = 'analytics_consent';
export const ANALYTICS_CONSENT_SIG_COOKIE = 'analytics_consent_sig';

/**
 * Имя cookie с guest-идентификатором (UUID + HMAC). Формат значения:
 * `<uuid>.<base64url(hmac256(secret, uuid))>` — самодостаточная подпись,
 * проверяется одним вызовом HMAC.
 */
export const GUEST_ID_COOKIE = 'guest_id';

/**
 * Префикс «hot counter» в Redis (ADR §2.4 слой 2). Полный ключ:
 * `agg:<actor_id>:<type>:<window_id>`. INCR + EXPIRE.
 */
export const AGG_KEY_PREFIX = 'agg:';

/**
 * Окна короткого счётчика (секунды). Только эти три считаем в hot path
 * (см. §2.4). Длинные (24h/7d/30d) — через matviews, не Redis.
 */
export const AGG_WINDOWS_SEC = {
  '1m': 60,
  '10m': 600,
  '1h': 3_600,
} as const;
export type AggWindowKey = keyof typeof AGG_WINDOWS_SEC;
