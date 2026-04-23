import type { CourseFixture } from '../fixture-types';
import { demoCourse } from './demo';

/**
 * Полный список курсов для накатки.
 *
 * После KS-1791 контент курса «Начинающий» удалён — раздел «Уроки»
 * стартует пустой. Новые курсы добавлять сюда по мере готовности
 * (фикстура в `./<course-slug>/index.ts` → импорт → запись в массив).
 *
 * `demoCourse` (KS-1793) — технический демо-курс для dev/QA. Удаляется
 * отсюда одним коммитом, когда появятся настоящие учебные курсы.
 */
export const COURSES: CourseFixture[] = [demoCourse];
