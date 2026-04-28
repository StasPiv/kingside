/**
 * KS-2104 — runtime feature flags.
 *
 * Контракт публичного `GET /api/config`:
 *   { featureFlags: FeatureFlags }
 *
 * Бэк хранит флаги в таблице `feature_flags`, при старте сервиса
 * сидит недостающие ключи дефолтами из whitelist в коде. Админ меняет
 * значения через `PATCH /api/admin/feature-flags/:key`.
 *
 * Контракт расширяется добавлением полей в `FeatureFlags` + ключа в
 * whitelist на бэке — без миграции БД (таблица key/value).
 */

export interface FeatureFlags {
  /**
   * KS-2105: показывать раздел «Уроки» в UI и пускать на `/lessons*`.
   * Default `true`; для аварийного откатa админ переключает в `false`
   * через PATCH без redeploy фронта.
   */
  lessonsEnabled: boolean;
}

export interface ConfigResponse {
  featureFlags: FeatureFlags;
}

export interface UpdateFeatureFlagRequest {
  value: boolean;
}

export interface UpdateFeatureFlagResponse {
  key: keyof FeatureFlags;
  value: boolean;
  updatedAt: string;
}

/**
 * KS-2108: элемент списка флагов на админ-странице.
 * `updatedAt` null если запись ещё не сидена (теоретически невозможно
 * после bootstrap, но защищаем тип).
 */
export interface AdminFeatureFlagItem {
  key: keyof FeatureFlags;
  value: boolean;
  defaultValue: boolean;
  description: string | null;
  updatedAt: string | null;
}

/** KS-2108: ответ `GET /api/profile/me/admin-status`. */
export interface AdminStatusResponse {
  isAdmin: boolean;
}
