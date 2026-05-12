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
  /**
   * KS-2217: показывать раздел «Задачи» в UI и пускать на `/puzzles*`.
   * Default `false` — раздел временно скрыт; включается админом через
   * PATCH без redeploy фронта.
   */
  puzzlesEnabled: boolean;
  /**
   * KS-2217: показывать раздел «Трансляции» в UI и пускать на
   * `/broadcasts*`. Default `true`; админ выключает через PATCH без
   * redeploy фронта.
   */
  broadcastsEnabled: boolean;
  /**
   * KS-2217: показывать раздел «Турниры» в UI и пускать на
   * `/tournaments*`. Default `true`; админ выключает через PATCH без
   * redeploy фронта.
   */
  tournamentsEnabled: boolean;
  /**
   * KS-2222: показывать чат-ассистент (`ChatWidget`, иконка чата в
   * правом нижнем углу). Default `false` — раздел временно скрыт;
   * включается админом через PATCH без redeploy фронта.
   */
  assistantEnabled: boolean;
  /**
   * KS-2231 (ADR-035 §7.2, Drills E2): показывать раздел «Тренажёры»
   * в UI и пускать на `/drills*`. Default `false` — фича пока в
   * разработке; включается админом через PATCH без redeploy фронта.
   */
  drillsEnabled: boolean;
  /**
   * KS-2815 / ADR-059 (KS-2823 T8): показывать раздел «Студии» в UI
   * и пускать на `/studies*`. Default `false` — фича в MVP, включается
   * админом через PATCH когда раздел готов. Sidebar-пункт «🧪 Студии»
   * (KS-2832) рендерится только при `true`.
   */
  studiesEnabled: boolean;
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
