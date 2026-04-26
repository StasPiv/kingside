import type { CourseFixture } from '../fixture-types';
import { demoCourse } from './demo';
import { matePatternsCourse } from './mate-patterns';

/**
 * Полный список курсов для накатки.
 *
 * После KS-1791 контент курса «Начинающий» удалён — раздел «Уроки»
 * стартует пустой. Новые курсы добавлять сюда по мере готовности
 * (фикстура в `./<course-slug>/index.ts` → импорт → запись в массив).
 *
 * `demoCourse` (KS-1793) — технический демо-курс для dev/QA. Удаляется
 * отсюда одним коммитом, когда появятся настоящие учебные курсы.
 *
 * `matePatternsCourse` (KS-1954) — второй системный курс для dev-стенда,
 * чтобы можно было визуально проверить Hero Variant C (≥2 активных
 * курсов одновременно, KS-1938). Удаляется вместе с `demoCourse`.
 */
export const COURSES: CourseFixture[] = [demoCourse, matePatternsCourse];
