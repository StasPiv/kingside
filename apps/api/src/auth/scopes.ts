/**
 * KS-4674 / ADR-146 §2.4. Центральный TS-реестр scope-строк
 * service-аккаунтов. Не runtime-валидация, а соглашение по соседству
 * с `required-scope.decorator.ts` — опечатки `@RequiredScope('reportoire:write')`
 * ловятся компилятором, scope-список доступен админ-CLI/UI в одном месте.
 *
 * Принцип ADR-139 не меняется: `ServiceAccountGuard` принимает любую
 * строку из `account.scopes`, поддерживает wildcards (`blog:*`, `*`).
 * Жёсткий whitelist на guard НЕ вводим — обратная совместимость с уже
 * выданными токенами и с будущими scope'ами, ещё не попавшими в
 * `SCOPES`, сохраняется.
 *
 * Добавление нового scope: дописать строку сюда, дёрнуть
 * `@RequiredScope(SCOPES.X)` в нужном контроллере, выдать токену
 * сервис-аккаунта через админ-CLI (T4 ADR-139).
 */
export const SCOPES = {
  /** KS-4455 / ADR-139 T5. CRUD блог-постов и авторов. */
  BLOG_WRITE: 'blog:write',
  /** KS-4674 / ADR-146. CRUD дебютных репертуаров (демо-набор). */
  REPERTOIRE_WRITE: 'repertoire:write',
  /** KS-4702 / ADR-147 §3.3. CRUD контекстных подсказок (`Hint` в schema events). */
  HINTS_WRITE: 'hints:write',
  /** KS-4801 / ADR-152. Read-доступ к `events.actor_events` произвольного
   *  actor для диагностики (симметричный `GET /me/events`). */
  EVENTS_READ: 'events:read',
} as const;

export type ScopeString = (typeof SCOPES)[keyof typeof SCOPES];
