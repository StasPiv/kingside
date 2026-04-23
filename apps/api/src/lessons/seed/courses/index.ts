import type { CourseFixture } from '../fixture-types';
import { beginnerCourse } from './beginner';

/**
 * Полный список курсов для накатки. Добавляй сюда новые фикстуры
 * по мере появления (в `./<course-slug>/index.ts`).
 */
export const COURSES: CourseFixture[] = [beginnerCourse];
