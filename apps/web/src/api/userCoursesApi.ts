import type {
  CompleteUserLessonRequest,
  CourseAuthorListResponse,
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
  UserEnrolledCoursesListResponse,
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

// NestJS-контроллеры смонтированы на `/lessons/*` (без `/api`-префикса —
// см. `apps/web/src/api/lessonsApi.ts` как эталон). В описании задачи
// `/api/lessons/...` был концептуальным именованием REST-endpoint'а, но
// фактический controller path — `/lessons/user-courses/…`.
const BASE = '/lessons';

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

  /**
   * GET /api/lessons/user-courses?mine=0&limit=N — последние публичные
   * курсы любых авторов (KS-1918 / KS-1919). Sort `updatedAt DESC`
   * на BE. Без авторизации не отдаёт чужие курсы — JWT нужен.
   */
  listLatest(opts: { limit: number }): Promise<UserCourseListResponse> {
    const qs = toQueryString({
      mine: '0',
      limit: String(opts.limit),
    });
    return api.get<UserCourseListResponse>(`${BASE}/user-courses${qs}`);
  },

  /**
   * GET /api/lessons/user-courses/authors — авторы с публичными
   * курсами (KS-1918 / KS-1919 + KS-1920). Без JWT (публичная
   * витрина), кеш 5 минут на BE с инвалидацией при publish/unpublish.
   *
   * - `sort: 'courses'` → publicCoursesCount DESC, lastCourseUpdatedAt DESC.
   * - `sort: 'recent'`  → lastCourseUpdatedAt DESC.
   * - `limit` 1..50 (default 50), `offset` 0..1000 (default 0).
   */
  listAuthors(opts: {
    sort?: 'courses' | 'recent';
    limit?: number;
    offset?: number;
  }): Promise<CourseAuthorListResponse> {
    const qs = toQueryString({
      sort: opts.sort,
      limit: opts.limit !== undefined ? String(opts.limit) : undefined,
      offset: opts.offset !== undefined ? String(opts.offset) : undefined,
    });
    return api.get<CourseAuthorListResponse>(
      `${BASE}/user-courses/authors${qs}`,
    );
  },

  /**
   * GET /api/lessons/user-courses/enrolled — курсы, которые юзер
   * проходит (или прошёл), но НЕ владеет ими (KS-1889 / KS-1890).
   * DTO включает `progress` сразу, без N+1.
   */
  listEnrolled(): Promise<UserEnrolledCoursesListResponse> {
    return api.get<UserEnrolledCoursesListResponse>(
      `${BASE}/user-courses/enrolled`,
    );
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

  // ─── Progress (BE-4, KS-1833) ───────────────────────────────────────

  /**
   * POST /api/lessons/user-progress/lessons/:userLessonId/step —
   * отметить состояние шага. `userLessonId` — URL-параметр, тело —
   * только `{stepId, state}`.
   */
  updateStepProgress(
    userLessonId: string,
    body: Pick<UpdateUserStepProgressRequest, 'stepId' | 'state'>,
  ): Promise<UserLessonPlayProgressDto> {
    return api.post<UserLessonPlayProgressDto>(
      `${BASE}/user-progress/lessons/${encodeURIComponent(userLessonId)}/step`,
      body,
    );
  },

  /**
   * POST /api/lessons/user-progress/lessons/:userLessonId/complete —
   * финальное завершение урока с overall `score` (ADR-026 §2.1 — SM-2
   * к пользовательским курсам не подключён; `score` 0..1).
   */
  completeLesson(
    userLessonId: string,
    body: Pick<CompleteUserLessonRequest, 'score'>,
  ): Promise<UserCoursePlayProgressDto> {
    return api.post<UserCoursePlayProgressDto>(
      `${BASE}/user-progress/lessons/${encodeURIComponent(userLessonId)}/complete`,
      body,
    );
  },

  /** GET /api/lessons/user-progress/courses/:userCourseId. */
  getCourseProgress(
    userCourseId: string,
  ): Promise<UserCoursePlayProgressDto | null> {
    return api.get<UserCoursePlayProgressDto | null>(
      `${BASE}/user-progress/courses/${encodeURIComponent(userCourseId)}`,
    );
  },

  /** GET /api/lessons/user-progress/lessons/:userLessonId. */
  getLessonProgress(
    userLessonId: string,
  ): Promise<UserLessonPlayProgressDto | null> {
    return api.get<UserLessonPlayProgressDto | null>(
      `${BASE}/user-progress/lessons/${encodeURIComponent(userLessonId)}`,
    );
  },
};
