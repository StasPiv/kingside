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
  PuzzleDto,
  PuzzleStepPayload,
  ReviewsDueResponse,
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

  /**
   * Отметка прогресса шага (KS-1784).
   *
   * Реальный backend (apps/api) ждёт `lessonId` в body класс-валидатором
   * (`POST /lessons/progress/step` → 400 «lessonId must be a UUID» без него).
   * shared-тип `UpdateLessonStepRequest` lessonId не объявляет — это
   * расхождение между shared и backend DTO; пока shared не обновили,
   * передаём lessonId отдельным аргументом и подмешиваем в body.
   */
  updateStep(
    lessonId: string,
    payload: UpdateLessonStepRequest,
  ): Promise<UpdateLessonStepResponse> {
    return api.post<UpdateLessonStepResponse>('/lessons/progress/step', {
      lessonId,
      ...payload,
    });
  },

  /**
   * Завершение урока (KS-1784).
   *
   * Реальный путь — `POST /lessons/progress/lesson/complete` (без id в URL),
   * lessonId передаётся в body вместе со score. Это соответствует L-04
   * (KS-1759) и `apps/api/src/lessons/progress.controller.ts`. Изначально
   * (L-11) фронт стучал на `/lessons/progress/lesson/<id>/complete` — 404.
   */
  completeLesson(
    lessonId: string,
    payload: CompleteLessonRequest,
  ): Promise<CompleteLessonResponse> {
    return api.post<CompleteLessonResponse>('/lessons/progress/lesson/complete', {
      lessonId,
      ...payload,
    });
  },

  /**
   * KS-1928 / ADR-032: методы дневника ошибок (`getMistakeAggregates`,
   * `getMistakeRecommendations`) переехали в `puzzleMistakesApi.ts`.
   * BE-эндпоинты — `/puzzle/mistakes/*`.
   */

  /**
   * SM-2 «К повторению сегодня» (L-22 / KS-1799). Бэк — KS-1798.
   *
   * Отдаёт только уроки текущего пользователя, у которых `dueAt <= now`.
   * Пустой список — нормальная ситуация (нечего повторять).
   */
  getReviewsDue(): Promise<ReviewsDueResponse> {
    return api.get<ReviewsDueResponse>('/lessons/reviews/due');
  },

  /**
   * Батч-резолвер задач для PuzzleStep (KS-1777 / KS-1780). Принимает
   * полный `PuzzleStepPayload` (`{ type:'puzzle', selection, ... }`),
   * возвращает массив задач — для `mode='ids'` сохраняет порядок,
   * для `mode='filter'` отдаёт уникальные задачи в количестве ≤ `limit`.
   *
   * Заменяет N-кратный `puzzleApi.getNext()` fallback из L-09.
   */
  resolvePuzzleStep(payload: PuzzleStepPayload): Promise<PuzzleDto[]> {
    return api.post<PuzzleDto[]>('/lessons/puzzle-step/resolve', payload);
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
