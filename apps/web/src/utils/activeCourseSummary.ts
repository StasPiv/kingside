import type {
  ActiveCourseDto,
  ActiveEnrolledCourseDto,
  ActiveSystemCourseDto,
} from '@kingside/shared';

import type { ActiveCourseSummary } from '../hooks/useLessonsHeroContext';

/**
 * KS-1957: маппинг `ActiveCourseDto` (бэк-агрегат `/lessons/active-courses`)
 * в внутренний `ActiveCourseSummary`, который потребляют Hero и
 * MyActiveCoursesPage.
 *
 * До KS-1957 каждое из мест писало свой маппинг для `system`
 * (`CourseListItem`) и `enrolled` (`UserEnrolledCourseDto`); теперь у
 * бэка единый дискриминированный union — фронт сужает по `kind` и
 * заполняет общую shape.
 *
 * Унификация важна, потому что Hero берёт ОДИН (variant `continue`),
 * а MyActiveCoursesPage все, и оба хотят одинаковое визуальное
 * представление через `<CourseCard>`.
 */

function mapSystem(c: ActiveSystemCourseDto): ActiveCourseSummary {
  return {
    source: 'system',
    id: c.id,
    slug: c.slug,
    title: '',
    titleI18nKey: c.titleI18nKey,
    level: c.level,
    coverUrl: c.coverUrl ?? null,
    lessonCount: c.lessonCount,
    completedLessons: c.lessonsCompleted,
    lastActivityAt: c.lastActivityAt,
    currentLessonSlug: c.currentLessonSlug,
    currentLessonTitleI18nKey: c.currentLessonTitleI18nKey,
    currentLessonTitle: null,
    currentLessonOrder: c.currentLessonOrder,
    href: `/lessons/${c.slug}`,
  };
}

function mapEnrolled(c: ActiveEnrolledCourseDto): ActiveCourseSummary {
  return {
    source: 'enrolled',
    id: c.id,
    slug: c.slug,
    title: c.title,
    titleI18nKey: null,
    level: null,
    coverUrl: null,
    lessonCount: c.lessonCount,
    completedLessons: c.lessonsCompleted,
    lastActivityAt: c.lastActivityAt,
    currentLessonSlug: c.currentLessonSlug,
    currentLessonTitleI18nKey: null,
    currentLessonTitle: c.currentLessonTitle,
    currentLessonOrder: c.currentLessonOrder,
    href: `/lessons/my/${c.slug}`,
  };
}

export function mapActiveCourse(c: ActiveCourseDto): ActiveCourseSummary {
  return c.kind === 'system' ? mapSystem(c) : mapEnrolled(c);
}

/**
 * Сервер уже отдаёт массив отсортированным по `lastActivityAt` DESC;
 * хелпер просто маппит каждый элемент. Сортировку фронт НЕ делает
 * — единый источник правды на бэке.
 */
export function mapActiveCourses(
  list: ActiveCourseDto[],
): ActiveCourseSummary[] {
  return list.map(mapActiveCourse);
}
