/**
 * KS-4130 / ADR-128 §6.8.3. Единый DTO-маппер: скрывает приватные
 * поля сущностей (user, coach, player, comment, lecture, …) при
 * ответе анонимному viewer'у.
 *
 * Список полей зафиксирован в ADR-128 §6.8.3 и НЕ переопределяется
 * локально в контроллерах. Если какой-то API случайно начнёт отдавать
 * новую сущность с одним из этих имён — гость её НЕ увидит, что
 * соответствует политике «по умолчанию скрываем приватное».
 *
 * Применение:
 *
 *   import { toPublicDto } from '../common/public-dto.mapper';
 *   // ...
 *   return toPublicDto(entity, req.user);
 *
 * Где `req.user` — результат `OptionalJwtGuard` (`undefined`/`null` =
 * гость; объект с `id` = авторизованный пользователь).
 *
 * Маппер рекурсивен: режет приватные поля и во вложенных объектах /
 * массивах (например, у автора комментария к партии — `email`).
 *
 * Для авторизованных viewer'ов маппер возвращает entity как есть —
 * политика приватности для пары «авторизованный смотрит на чужой
 * профиль» решается на уровне сервиса (ADR-128 §6.8 такой развязки
 * не требует).
 */

/**
 * Полный whitelist приватных полей (ADR-128 §6.8.3).
 *
 * Если поле добавляется в этот список — оно скрывается и в корне DTO,
 * и в любых nested-объектах. Имена сверены с Prisma-схемой
 * (`prisma/schema.prisma`) и текущими DTO; список — единственный
 * источник правды.
 */
export const PRIVATE_DTO_FIELDS: ReadonlySet<string> = new Set([
  // Личные контакты
  'email',
  'emailVerified',
  'phone',
  'phoneVerified',
  // Связи аккаунтов
  'oauthIds',
  'googleId',
  'facebookId',
  'telegramId',
  // Модераторские пометки
  'privateNotes',
  'internalNotes',
  // Платёжная информация
  'subscription',
  'paymentMethod',
  'lastInvoice',
  // Telemetry
  'lastSeenAt',
  'lastIp',
  'userAgent',
  // Настройки приватности
  'privacyFlags',
  // Социальный граф
  'friends',
  'blockedUsers',
]);

/**
 * Минимальная форма viewer'а — гарантирует только наличие `id`
 * у авторизованного. Точный тип Passport-payload (`req.user`)
 * варьируется по проекту — маппер берёт его как unknown с
 * narrow'ом.
 */
export type ViewerLike = { id: string } | null | undefined;

function isViewerAuthenticated(viewer: ViewerLike): boolean {
  return !!(viewer && typeof viewer === 'object' && 'id' in viewer && viewer.id);
}

/**
 * Приведение сущности к публичному виду.
 *
 * - `viewer` авторизован (есть `id`) → возвращаем entity без изменений
 *   (политика «свой смотрит на чужого» — задача сервиса, не маппера).
 * - `viewer` отсутствует → рекурсивно вырезаем поля из
 *   `PRIVATE_DTO_FIELDS`.
 *
 * Прим. реализации:
 * 1. Примитивы / `null` / `Date` / `Buffer` — возвращаем как есть
 *    (Date — это объект, но не «контейнер с полями» в смысле DTO).
 * 2. Массивы — мапим элементы рекурсивно.
 * 3. Plain object — пересобираем без приватных ключей; для оставшихся
 *    значений применяем маппер рекурсивно (nested-сущности).
 * 4. Класс-инстансы (Prisma-объекты — plain) трактуются как объекты.
 */
export function toPublicDto<T>(entity: T, viewer?: ViewerLike): T {
  if (isViewerAuthenticated(viewer)) return entity;
  return stripPrivate(entity) as T;
}

function stripPrivate(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return value;

  if (Array.isArray(value)) {
    return value.map((v) => stripPrivate(v));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_DTO_FIELDS.has(key)) continue;
    out[key] = stripPrivate(val);
  }
  return out;
}
