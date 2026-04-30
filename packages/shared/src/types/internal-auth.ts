/**
 * KS-2182 (ADR-034-v2 §2, §10.1, §10.7). Контракты внутренних endpoint'ов
 * `apps/api/internal/*`, к которым ходит `apps/synthetic-bot-service`.
 *
 * Эти типы — единый источник истины для:
 *   - `apps/api` (controller'ы выдачи токенов / списка synthetic-юзеров /
 *     batch-update presence);
 *   - `apps/synthetic-bot-service` (`BotTokenService`, `BotManager`,
 *     `presence.service.ts`).
 *
 * Все endpoint'ы за `InternalKeyGuard` (заголовок `X-Internal-Auth:
 * $SYNTHETIC_BOT_INTERNAL_KEY`), доступны только из VPC. ALB-rule блокирует
 * `/internal/*` извне (devops Dv7 — отдельная задача).
 */

/** HTTP-заголовок shared-secret для всех internal endpoint'ов. */
export const INTERNAL_AUTH_HEADER = 'X-Internal-Auth';

/**
 * Тело запроса `POST /api/internal/auth/synthetic-token`.
 *
 * `botUserId` — UUID synthetic-пользователя (`User.isSynthetic = true`).
 * Endpoint падает 403, если у указанного user'а флаг false (см. ADR §2.2 —
 * критично, иначе через дыру можно нагенерить JWT для любого user.id).
 */
export interface SyntheticTokenRequest {
  botUserId: string;
}

/**
 * Ответ `POST /api/internal/auth/synthetic-token`.
 *
 * `accessToken` — обычный платформенный JWT с payload `{sub: <user.id>,
 * username: <user.username>}`. Никаких bot-only флагов в payload (ADR §2.1
 * — любой signal в токене утекает в логи и может быть использован живыми
 * пользователями для детекции).
 *
 * `expiresIn` — TTL в секундах. По умолчанию 900 (15 минут — стандартный
 * TTL живых юзеров; ADR §11 п.2).
 */
export interface SyntheticTokenResponse {
  accessToken: string;
  expiresIn: number;
}

/**
 * Элемент ответа `GET /api/internal/synthetic-users`. Отдаётся только
 * synthetic'ам (`WHERE isSynthetic = true`), без `passwordHash`,
 * `email` и прочих чувствительных полей — bot-service использует только
 * id, username и рейтинги.
 */
export interface SyntheticUserListItem {
  id: string;
  username: string;
  rating: {
    bullet: number;
    blitz: number;
    rapid: number;
    classical: number;
  };
}

/** Один элемент batch'а в `POST /api/internal/synthetic-presence`. */
export interface SyntheticPresenceUpdate {
  userId: string;
  /** ISO-string. На сервере конвертируется в `Date`. */
  lastSeenAt: string;
}

/**
 * Тело `POST /api/internal/synthetic-presence`.
 *
 * Сервер проверяет `isSynthetic = true` для КАЖДОГО userId; при наличии
 * хотя бы одного non-synthetic — 403, ни одна запись не обновляется
 * (валидация первым проходом, потом транзакция).
 */
export interface SyntheticPresenceBatchRequest {
  updates: SyntheticPresenceUpdate[];
}

/**
 * Ответ `POST /api/internal/synthetic-presence`. `updated` — число
 * фактически обновлённых строк (на случай, если кто-то из переданных
 * userId был удалён из БД между вызовами).
 */
export interface SyntheticPresenceBatchResponse {
  updated: number;
}
