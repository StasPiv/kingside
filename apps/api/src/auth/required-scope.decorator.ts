/**
 * KS-4455 / ADR-139 §3. Декоратор `@RequiredScope('blog:write')` —
 * ставит метаданные на handler/класс, которые `AdminOrServiceGuard`
 * читает через `Reflector` и сверяет со `scopes` сервисного аккаунта.
 *
 * Действует ТОЛЬКО для service-account-аутентификации (когда
 * `req.user.isServiceAccount === true`). JWT-админ (human) проходит
 * без проверки scope — у админа неявно «все права».
 *
 * Wildcard: `'blog:*'` покрывает любой `blog:<action>`. Для строгого
 * совпадения используй конкретный action: `'blog:write'`.
 */
import { SetMetadata } from '@nestjs/common';

export const REQUIRED_SCOPE_METADATA = 'kingside.required_scope';

export const RequiredScope = (scope: string) =>
  SetMetadata(REQUIRED_SCOPE_METADATA, scope);

/**
 * Проверка scope с поддержкой wildcards. Правила:
 *   * точное совпадение: `'blog:write'` ∈ scopes → true;
 *   * `'<resource>:*'` ∈ scopes → matches `'<resource>:<action>'` для
 *     любого `<action>` (включая `'*'`);
 *   * глобальный `'*'` ∈ scopes → matches всё (для super-агентов).
 *
 * Не matches:
 *   * `'blog:*'` против `'blog'` (без двоеточия) — это другой ресурс;
 *   * `'blog:*'` против `'lessons:write'` — другой префикс;
 *   * `'blog:write'` против `'blog:read'` — exact action mismatch.
 */
export function hasScope(
  userScopes: readonly string[],
  required: string,
): boolean {
  if (!required) return false;
  if (userScopes.includes('*')) return true;
  if (userScopes.includes(required)) return true;
  const colon = required.indexOf(':');
  if (colon === -1) return false;
  const resourceWildcard = `${required.slice(0, colon)}:*`;
  return userScopes.includes(resourceWildcard);
}
