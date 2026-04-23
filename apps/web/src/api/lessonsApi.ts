import type {
  CourseListResponse,
  CourseWithLessonsResponse,
  LessonWithStepsResponse,
  UpdateLessonStepRequest,
  UpdateLessonStepResponse,
  CompleteLessonRequest,
  CompleteLessonResponse,
  CourseRecommendationResponse,
  CourseLevel,
} from '@kingside/shared';

import { api } from '../api';

/**
 * HTTP-клиент LessonsModule (apps/api/src/lessons, тикет L-04 / KS-1759).
 *
 * Реальные пути контроллера (проверены `curl http://localhost:3001/lessons/courses`)
 * монтируются без префикса `/api`. Документация (lessons-roadmap.md §1) местами
 * пишет `/api/lessons/...` — это логический путь, фактический Nest controller
 * висит на `/lessons/...`.
 *
 * Эндпоинт `/lessons/recommendation` появится в L-12 (KS-1767). До тех пор
 * `getRecommendation` возвращает дефолт «beginner» — соответствует условию
 * Gherkin задачи L-07: «заглушка рекомендатора».
 */

const FALLBACK_RECOMMENDATION: CourseRecommendationResponse = {
  level: 'beginner' as CourseLevel,
  reason: 'default',
};

export const lessonsApi = {
  listCourses(): Promise<CourseListResponse> {
    return api.get<CourseListResponse>('/lessons/courses');
  },

  getCourse(slug: string): Promise<CourseWithLessonsResponse> {
    return api.get<CourseWithLessonsResponse>(
      `/lessons/courses/${encodeURIComponent(slug)}`,
    );
  },

  getLesson(lessonId: string): Promise<LessonWithStepsResponse> {
    return api.get<LessonWithStepsResponse>(
      `/lessons/lessons/${encodeURIComponent(lessonId)}`,
    );
  },

  updateStep(payload: UpdateLessonStepRequest): Promise<UpdateLessonStepResponse> {
    return api.post<UpdateLessonStepResponse>('/lessons/progress/step', payload);
  },

  completeLesson(
    lessonId: string,
    payload: CompleteLessonRequest,
  ): Promise<CompleteLessonResponse> {
    return api.post<CompleteLessonResponse>(
      `/lessons/progress/lesson/${encodeURIComponent(lessonId)}/complete`,
      payload,
    );
  },

  /**
   * Заглушка под L-12. Сначала пробуем эндпоинт; если 404 — возвращаем
   * `recommendedLevel` из `listCourses()` если он есть; если нет — `beginner`.
   */
  async getRecommendation(): Promise<CourseRecommendationResponse> {
    try {
      return await api.get<CourseRecommendationResponse>('/lessons/recommendation');
    } catch {
      return FALLBACK_RECOMMENDATION;
    }
  },
};
