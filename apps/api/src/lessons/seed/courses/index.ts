import type { CourseFixture } from '../fixture-types';

/**
 * Полный список курсов для накатки.
 *
 * После KS-1791 контент курса «Начинающий» удалён — раздел «Уроки»
 * стартует пустой. Новые курсы добавлять сюда по мере готовности
 * (фикстура в `./<course-slug>/index.ts` → импорт → запись в массив).
 */
export const COURSES: CourseFixture[] = [];
