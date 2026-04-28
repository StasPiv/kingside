/**
 * Feature-flag helpers — build-time pure-функции (KS-1820).
 *
 * KS-2105: runtime-чтение флагов из backend (`GET /config`) живёт в
 * `apps/web/src/context/FeatureFlagsContext.tsx`. App.tsx и Sidebar.tsx
 * с этого тикета используют `useFeatureFlag('lessonsEnabled')` —
 * `import.meta.env.VITE_FEATURE_LESSONS` в коде фронта больше не
 * читается.
 *
 * Этот файл сохранён только ради `areDevRoutesEnabled` (документация
 * поведения dev-страниц) и `isLessonsEnabled` — последняя оставлена
 * как pure-helper для unit-тестов на случай, если в будущем
 * понадобится считать env-флаг (например, e2e-bypass FeatureFlags
 * через переменную). В рантайме фронта не вызывается.
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
 *
 * KS-2105: в рантайме фронта НЕ используется — runtime-источник
 * правды переехал в `FeatureFlagsContext` / `GET /config`. Функция
 * сохранена как pure-helper для unit-тестов и потенциальных
 * env-bypass сценариев.
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
