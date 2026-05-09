import type { ListLessonsCoursesParams } from './lessonsApi';
import { lessonsApi } from './lessonsApi';

/**
 * # KS-2645 (ADR-054 Phase D) — DEPRECATED, скоро удалю.
 *
 * Этот модуль превращён в тонкий алиас над `lessonsApi`. Все методы
 * проксируются с маппингом старых имён на новые:
 *
 *   userCoursesApi.list({scope})         → lessonsApi.list({mine})
 *   userCoursesApi.listLatest            → lessonsApi.listLatest
 *   userCoursesApi.listAuthors           → lessonsApi.listAuthors
 *   userCoursesApi.listEnrolled          → lessonsApi.listEnrolled
 *   userCoursesApi.getBySlug             → lessonsApi.getUserCourse
 *   userCoursesApi.create                → lessonsApi.createCourse
 *   userCoursesApi.update                → lessonsApi.updateCourse
 *   userCoursesApi.delete                → lessonsApi.deleteCourse
 *   userCoursesApi.createLesson          → lessonsApi.createLesson
 *   userCoursesApi.getLesson             → lessonsApi.getUserLesson
 *   userCoursesApi.updateLesson          → lessonsApi.updateLesson
 *   userCoursesApi.deleteLesson          → lessonsApi.deleteLesson
 *   userCoursesApi.createStep            → lessonsApi.createStep
 *   userCoursesApi.updateStep            → lessonsApi.updateStepPayload
 *   userCoursesApi.deleteStep            → lessonsApi.deleteStep
 *   userCoursesApi.reorderSteps          → lessonsApi.reorderSteps
 *   userCoursesApi.updateStepProgress    → lessonsApi.markStep
 *   userCoursesApi.completeLesson        → lessonsApi.completeLesson
 *   userCoursesApi.getCourseProgress     → lessonsApi.getCourseProgress
 *   userCoursesApi.getLessonProgress     → lessonsApi.getLessonProgress
 *
 * Импорты, использующие `userCoursesApi`, будут массово переключены
 * на `lessonsApi.*` отдельным коммитом, после чего файл удаляется.
 *
 * **Не добавляй сюда новые методы** — добавляй сразу в `lessonsApi`.
 */

/** Старый сигнатурный параметр `{scope: 'own' | 'public'}`. */
export interface ListUserCoursesParams {
  scope?: 'own' | 'public';
}

function scopeToMineParams(
  params?: ListUserCoursesParams,
): ListLessonsCoursesParams & { mine: boolean } {
  return { mine: params?.scope !== 'public' };
}

export const userCoursesApi = {
  list: (params?: ListUserCoursesParams) =>
    lessonsApi.list(scopeToMineParams(params)),
  listLatest: lessonsApi.listLatest,
  listAuthors: lessonsApi.listAuthors,
  listEnrolled: lessonsApi.listEnrolled,
  getBySlug: lessonsApi.getUserCourse,
  create: lessonsApi.createCourse,
  update: lessonsApi.updateCourse,
  delete: lessonsApi.deleteCourse,
  createLesson: lessonsApi.createLesson,
  getLesson: lessonsApi.getUserLesson,
  updateLesson: lessonsApi.updateLesson,
  deleteLesson: lessonsApi.deleteLesson,
  createStep: lessonsApi.createStep,
  updateStep: lessonsApi.updateStepPayload,
  deleteStep: lessonsApi.deleteStep,
  reorderSteps: lessonsApi.reorderSteps,
  updateStepProgress: lessonsApi.markStep,
  completeLesson: lessonsApi.completeLesson,
  getCourseProgress: lessonsApi.getCourseProgress,
  getLessonProgress: lessonsApi.getLessonProgress,
};
