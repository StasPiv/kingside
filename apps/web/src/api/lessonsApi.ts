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
  LevelGateResponse,
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
   * Level-gate (L-15 / KS-1770 / KS-1781). Возвращает текущий уровень,
   * следующий уровень и список блокеров перехода. Бэкенд считает по
   * прогрессу курса, ratingPuzzle и сыгранным партиям.
   */
  getLevelGate(): Promise<LevelGateResponse> {
    return api.get<LevelGateResponse>('/lessons/level-gate');
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
