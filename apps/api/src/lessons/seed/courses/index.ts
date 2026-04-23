import type { CourseFixture } from '../fixture-types';
import { beginnerBasics } from './beginner-basics';

/**
 * Полный список курсов для накатки. Добавляй сюда новые фикстуры
 * по мере появления (в `./<course-slug>.ts`).
 */
export const COURSES: CourseFixture[] = [beginnerBasics];
