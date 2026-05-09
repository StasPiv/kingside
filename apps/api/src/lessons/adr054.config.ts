/**
 * KS-2642 / ADR-054 §4 Phase C — feature flag.
 *
 * `ADR054_UNIFIED_API`:
 *   - `false` (default) — поведение Phase A/B: legacy-контроллеры
 *     `UserCoursesController` / `UserLessonsController` /
 *     `UserLessonStepsController` / `UserProgressController` активны и
 *     пишут/читают пользовательские данные через `user_*` таблицы. Это
 *     безопасный rollback-режим.
 *   - `true` — alias-режим: legacy-роуты отвечают `HTTP 308 Permanent
 *     Redirect` на унифицированные `/lessons/*` URL. Унифицированные
 *     роуты обрабатываются объединёнными `CoursesController` /
 *     `LessonsController` / `LessonStepsController` /
 *     `ProgressController` поверх единых таблиц `courses` / `lessons` /
 *     `lesson_steps` / `user_course_progress` / `user_lesson_progress`
 *     (которые в Phase E переименуются в `course_progress` /
 *     `lesson_progress`).
 *
 * Прочесть с явной нормализацией: `'true' | 'false' | undefined` →
 * `boolean`. Любое другое значение трактуется как `false` — эта
 * семантика осознанная (чтобы случайная опечатка не врубала миграцию
 * в проде).
 *
 * Используется на этапе **module-load** — `process.env` фиксируется
 * один раз при `import` файла; в рантайме переключение требует
 * рестарта процесса (acceptable для Phase C: enable/disable идёт через
 * деплой нового task-def).
 */

export const ADR054_UNIFIED_API_ENV_VAR = 'ADR054_UNIFIED_API';

export function isAdr054UnifiedApi(): boolean {
  const raw = process.env[ADR054_UNIFIED_API_ENV_VAR];
  return raw === 'true';
}

/**
 * Mapping legacy → unified URL prefix'ов. Используется
 * `Adr054AliasController` для построения `Location`-заголовка 308-
 * редиректа.
 */
export const ADR054_ALIAS_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  // /lessons/user-courses/<...>      → /lessons/courses/<...>
  [/^(\/lessons)\/user-courses(\/.*)?$/, '$1/courses$2'],
  // /lessons/user-lessons/<...>      → /lessons/lessons/<...>
  [/^(\/lessons)\/user-lessons(\/.*)?$/, '$1/lessons$2'],
  // /lessons/user-lesson-steps/<...> → /lessons/steps/<...>
  [/^(\/lessons)\/user-lesson-steps(\/.*)?$/, '$1/steps$2'],
  // /lessons/user-progress/<...>     → /lessons/progress/<...>
  [/^(\/lessons)\/user-progress(\/.*)?$/, '$1/progress$2'],
];

/**
 * Переписывает legacy-URL в унифицированный. Возвращает `null`, если
 * URL не относится к ADR-054 alias-домену — вызывающий должен в этом
 * случае пропустить запрос дальше.
 *
 * Query-string сохраняется как есть (regex'ы выше matchятся только по
 * path-части, чтобы `\/.*` не «проедал» `?…`).
 */
export function rewriteAdr054AliasUrl(originalUrl: string): string | null {
  const queryIdx = originalUrl.indexOf('?');
  const path = queryIdx === -1 ? originalUrl : originalUrl.slice(0, queryIdx);
  const query = queryIdx === -1 ? '' : originalUrl.slice(queryIdx);
  for (const [re, replacement] of ADR054_ALIAS_REWRITES) {
    if (re.test(path)) {
      return path.replace(re, replacement) + query;
    }
  }
  return null;
}
