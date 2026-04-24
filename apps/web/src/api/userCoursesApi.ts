import type {
  CompleteUserLessonRequest,
  CreateUserCourseRequest,
  CreateUserLessonRequest,
  CreateUserLessonStepRequest,
  ReorderUserStepsRequest,
  UpdateUserCourseRequest,
  UpdateUserLessonRequest,
  UpdateUserLessonStepRequest,
  UpdateUserStepProgressRequest,
  UserCourseDto,
  UserCourseListResponse,
  UserCoursePlayProgressDto,
  UserCourseWithLessonsResponse,
  UserLessonDto,
  UserLessonPlayProgressDto,
  UserLessonStepDto,
  UserLessonWithStepsResponse,
} from '@kingside/shared';

import { api } from '../api';

/**
 * HTTP-клиент для пользовательских курсов (ADR-026, KS-1835 / FE-1).
 *
 * Пробрасывает все вызовы через общий `api.{get,post,patch,delete}` из
 * `apps/web/src/api.ts` — оттуда же приходит JWT из `localStorage.token`,
 * refresh на 401 и единая error-трансляция в `ApiError`. Здесь только
 * типизированные обёртки и URL-строки.
 *
 * Пути соответствуют BE-3 (`/api/lessons/user-*`):
 *  - `/user-courses`, `/user-courses/:slug`, `/user-courses/:id` — курсы
 *  - `/user-courses/:id/lessons`, `/user-lessons/:id` — уроки
 *  - `/user-lessons/:id/steps`, `/user-lesson-steps/:id` — шаги
 *  - `/user-lessons/:id/steps/reorder` — массовая перестановка порядка
 *  - `/user-progress/step`, `/user-progress/lesson/complete` — прогресс
 */

const BASE = '/api/lessons';

/** Фильтр списка пользовательских курсов (ADR-026 §2.5). */
export interface ListUserCoursesParams {
  /**
   * `own` — только мои курсы (любой видимости). `public` — все публичные
   * курсы всех авторов. По умолчанию backend отдаёт `own`.
   */
  scope?: 'own' | 'public';
}

function toQueryString(params?: Record<string, string | undefined>): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== '',
  );
  if (entries.length === 0) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of entries) qs.set(k, v as string);
  return `?${qs.toString()}`;
}

// ─── Courses ──────────────────────────────────────────────────────────

export const userCoursesApi = {
  /** GET /api/lessons/user-courses — список моих или публичных. */
  list(params?: ListUserCoursesParams): Promise<UserCourseListResponse> {
    const qs = toQueryString({ scope: params?.scope });
    return api.get<UserCourseListResponse>(`${BASE}/user-courses${qs}`);
  },

  /** GET /api/lessons/user-courses/:slug — курс + уроки + прогресс. */
  getBySlug(slug: string): Promise<UserCourseWithLessonsResponse> {
    return api.get<UserCourseWithLessonsResponse>(
      `${BASE}/user-courses/${encodeURIComponent(slug)}`,
    );
  },

  /** POST /api/lessons/user-courses — создать курс. */
  create(body: CreateUserCourseRequest): Promise<UserCourseDto> {
    return api.post<UserCourseDto>(`${BASE}/user-courses`, body);
  },

  /** PATCH /api/lessons/user-courses/:id — обновить курс. */
  update(id: string, body: UpdateUserCourseRequest): Promise<UserCourseDto> {
    return api.patch<UserCourseDto>(
      `${BASE}/user-courses/${encodeURIComponent(id)}`,
      body,
    );
  },

  /** DELETE /api/lessons/user-courses/:id — удалить курс со всеми уроками/шагами. */
  delete(id: string): Promise<void> {
    return api.delete<void>(
      `${BASE}/user-courses/${encodeURIComponent(id)}`,
    );
  },

  // ─── Lessons (вложены в курс) ───────────────────────────────────────

  /** POST /api/lessons/user-courses/:id/lessons — создать урок в курсе. */
  createLesson(
    courseId: string,
    body: CreateUserLessonRequest,
  ): Promise<UserLessonDto> {
    return api.post<UserLessonDto>(
      `${BASE}/user-courses/${encodeURIComponent(courseId)}/lessons`,
      body,
    );
  },

  /** GET /api/lessons/user-lessons/:id — урок + шаги + прогресс. */
  getLesson(id: string): Promise<UserLessonWithStepsResponse> {
    return api.get<UserLessonWithStepsResponse>(
      `${BASE}/user-lessons/${encodeURIComponent(id)}`,
    );
  },

  /** PATCH /api/lessons/user-lessons/:id — переименовать / переставить. */
  updateLesson(
    id: string,
    body: UpdateUserLessonRequest,
  ): Promise<UserLessonDto> {
    return api.patch<UserLessonDto>(
      `${BASE}/user-lessons/${encodeURIComponent(id)}`,
      body,
    );
  },

  /** DELETE /api/lessons/user-lessons/:id — удалить урок. */
  deleteLesson(id: string): Promise<void> {
    return api.delete<void>(
      `${BASE}/user-lessons/${encodeURIComponent(id)}`,
    );
  },

  // ─── Steps (вложены в урок) ─────────────────────────────────────────

  /** POST /api/lessons/user-lessons/:id/steps — создать шаг. */
  createStep(
    lessonId: string,
    body: CreateUserLessonStepRequest,
  ): Promise<UserLessonStepDto> {
    return api.post<UserLessonStepDto>(
      `${BASE}/user-lessons/${encodeURIComponent(lessonId)}/steps`,
      body,
    );
  },

  /** PATCH /api/lessons/user-lesson-steps/:id — обновить payload / order. */
  updateStep(
    id: string,
    body: UpdateUserLessonStepRequest,
  ): Promise<UserLessonStepDto> {
    return api.patch<UserLessonStepDto>(
      `${BASE}/user-lesson-steps/${encodeURIComponent(id)}`,
      body,
    );
  },

  /** DELETE /api/lessons/user-lesson-steps/:id — удалить шаг. */
  deleteStep(id: string): Promise<void> {
    return api.delete<void>(
      `${BASE}/user-lesson-steps/${encodeURIComponent(id)}`,
    );
  },

  /**
   * POST /api/lessons/user-lessons/:id/steps/reorder — массовая
   * перестановка порядка шагов в уроке в одной транзакции (ADR §2.5).
   */
  reorderSteps(
    lessonId: string,
    body: ReorderUserStepsRequest,
  ): Promise<void> {
    return api.post<void>(
      `${BASE}/user-lessons/${encodeURIComponent(lessonId)}/steps/reorder`,
      body,
    );
  },

  // ─── Progress ───────────────────────────────────────────────────────

  /** POST /api/lessons/user-progress/step — отметить состояние шага. */
  updateStepProgress(
    body: UpdateUserStepProgressRequest,
  ): Promise<UserLessonPlayProgressDto> {
    return api.post<UserLessonPlayProgressDto>(
      `${BASE}/user-progress/step`,
      body,
    );
  },

  /**
   * POST /api/lessons/user-progress/lesson/complete — финальное
   * завершение урока с overall `score` (SM-2 к пользовательским
   * курсам не подключён — ADR §2.1).
   */
  completeLesson(
    body: CompleteUserLessonRequest,
  ): Promise<UserCoursePlayProgressDto> {
    return api.post<UserCoursePlayProgressDto>(
      `${BASE}/user-progress/lesson/complete`,
      body,
    );
  },
};
