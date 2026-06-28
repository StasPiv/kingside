/**
 * KS-4747 / ADR-149 §G1. Shared-пакет для эмита actor-событий между
 * процессами apps/api и apps/game-service.
 *
 * Без Nest-DI, без сторонних зависимостей — чистый TS. Содержит:
 *   - Типы Actor / ActorType / EventPayload — повторяют формат
 *     `apps/api/src/events/events.types.ts` (источник истины для
 *     ингеста — `EventsService.track`).
 *   - DTO InternalEventInput для эндпоинта POST /internal/events
 *     (KS-4748 G2).
 *   - Константы event_type, которые self-эмитит game-service
 *     (KS-4750 G4) — `game_start`, `game_end`, `resign`,
 *     `draw_offered`.
 *   - Утилита serializePayload — синхронно с
 *     apps/api/src/events/events.service.ts (тот же контракт сериализации).
 *
 * Зависимый код:
 *   - apps/api/src/events/internal-events.controller.ts (G2) —
 *     валидирует входящий InternalEventInput.
 *   - apps/game-service/src/events-client/events-client.service.ts
 *     (G4) — формирует и подписывает POST.
 */

export type ActorType = 'user' | 'guest';

export interface Actor {
  type: ActorType;
  /** UUID. */
  id: string;
}

export type EventPayload = Record<string, unknown> | null | undefined;

/**
 * Типы событий, которые self-эмитит game-service в apps/api через
 * POST /internal/events. Список расширяется по мере добавления новых
 * источников — на стороне ingest (EventsService.track) валидация
 * по длине строки, имена whitelist'у не сверяет.
 */
export const GAME_SERVICE_EVENT_TYPES = [
  'game_start',
  'game_end',
  'resign',
  'draw_offered',
] as const;
export type GameServiceEventType = (typeof GAME_SERVICE_EVENT_TYPES)[number];

/**
 * DTO для POST /internal/events. Поля совпадают с аргументами
 * `EventsService.track(actor, type, payload, occurredAt?)`.
 *
 * `ts` — ISO-строка времени события на стороне эмиттера. Если не
 * передано — приёмник (G2) подставит серверное now().
 */
export interface InternalEventInput {
  actor: Actor;
  type: string;
  payload: EventPayload;
  /** ISO-8601, e.g. `2026-06-28T10:15:00.000Z`. */
  ts?: string;
}

/**
 * Сериализация payload в строку для XADD / Prisma. Контракт
 * синхронизирован с apps/api/src/events/events.service.ts
 * (private serializePayload). Циклы / BigInt → `{}` (writer не должен
 * падать на «битом» payload).
 */
export function serializePayload(payload: EventPayload): string {
  if (payload === undefined || payload === null) return '{}';
  try {
    return JSON.stringify(payload);
  } catch {
    return '{}';
  }
}

/**
 * Проверка валидности actor — те же правила, что в EventsService.
 * Выделено сюда, чтобы game-service мог отбраковывать события до
 * сетевого вызова. На стороне ingest проверка дублируется (G2).
 */
export function isValidActor(actor: Actor | undefined | null): actor is Actor {
  if (!actor || typeof actor !== 'object') return false;
  if (actor.type !== 'user' && actor.type !== 'guest') return false;
  if (typeof actor.id !== 'string' || actor.id.length === 0) return false;
  return true;
}

/**
 * Проверка валидности типа события — 1..64 символа (соответствует
 * `@db.VarChar(64)` в schema.prisma). Whitelist по именам не делаем
 * (см. EventsService).
 */
export function isValidEventType(type: string | undefined | null): type is string {
  return typeof type === 'string' && type.length > 0 && type.length <= 64;
}
