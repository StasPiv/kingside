/**
 * KS-1978: общий хелпер для рендера полей `Course` / `Lesson`,
 * у которых есть и inline-строка, и i18n-ключ.
 *
 * Контракт KS-1965 (`CourseInlineFields` / `LessonInlineFields`):
 *  ```
 *  const title = course.title ?? t(course.titleI18nKey);
 *  ```
 *
 * `null`/`undefined`/пустая строка inline — fallback на i18n-ключ.
 * Если и i18n-ключа нет (или там пусто), возвращается `fallback`
 * (по умолчанию пустая строка).
 *
 * Используется в LessonsHero / CurriculumPillarBlock /
 * RecommendedCoursesBlock / CoursePage / LessonPage /
 * MyActiveCoursesPage / activeCourseSummary.
 */

type Translator = (
  key: string,
  defaultValueOrOpts?: string | (Record<string, unknown> & { defaultValue?: string }),
) => string;

export function resolveInlineText(
  inline: string | null | undefined,
  i18nKey: string | null | undefined,
  t: Translator,
  fallback: string = '',
): string {
  if (inline != null && inline !== '') {
    return inline;
  }
  if (i18nKey) {
    // `t(key, defaultValue)` — i18next вернёт значение из словаря, если
    // оно есть, либо `defaultValue` (= наш fallback), либо сам ключ.
    return t(i18nKey, fallback);
  }
  return fallback;
}
