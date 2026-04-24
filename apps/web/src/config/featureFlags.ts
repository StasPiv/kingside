/**
 * Feature-flag центр (KS-1820).
 *
 * Единая точка чтения `import.meta.env.VITE_*` флагов. Экспортируемые
 * функции — чистые, без мемоизации: принимают объект env, чтобы тесты
 * могли передать свой без `vi.stubEnv`. Модульные wrapper'ы ниже
 * читают реальный `import.meta.env` и используются в компонентах.
 */

export interface FeatureEnv {
  readonly VITE_FEATURE_LESSONS?: string;
  readonly DEV?: boolean;
  readonly PROD?: boolean;
}

/**
 * Раздел «Уроки». Считается включённым только при явном `'true'`.
 *
 * На dev (`env.DEV === true`) без явно заданного значения — тоже
 * включён: разработка раздела продолжается и локально ничего
 * скрывать не нужно. На прод-билде пустая переменная = off.
 */
export function isLessonsEnabled(env: FeatureEnv): boolean {
  if (env.VITE_FEATURE_LESSONS === 'true') return true;
  if (env.VITE_FEATURE_LESSONS === 'false') return false;
  // Не задана → в dev включаем, в prod выключаем.
  return Boolean(env.DEV);
}

/**
 * Dev-страницы `/dev/*`. Включены только в vite DEV-режиме — на
 * prod-сборке vite выставляет `import.meta.env.PROD === true` и
 * `DEV === false`. Feature-flag для «Уроки» здесь не при чём:
 * dev-страницы скрываются независимо.
 *
 * Оставлен как чистая функция для документации поведения и unit-тестов.
 * В рантайме (App.tsx) этот условие НЕ используется — там стоит
 * compile-time guard `import.meta.env.DEV`, чтобы vite мог tree-shake'нуть
 * dev-страницы из prod-бандла целиком (KS-1821).
 */
export function areDevRoutesEnabled(env: FeatureEnv): boolean {
  return Boolean(env.DEV);
}

// ─── Module-level wrappers ───────────────────────────────────────────
// Эти функции читают реальный `import.meta.env` — используются в
// компонентах. В unit-тестах pure-функции выше позволяют передать
// собственный env без `vi.stubEnv`.

export function isLessonsEnabledLive(): boolean {
  return isLessonsEnabled(import.meta.env);
}
