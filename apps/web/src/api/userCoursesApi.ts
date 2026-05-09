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
 * HTTP-клиент для пользовательских курсов (ADR-026 / ADR-054).
 *
 * Пробрасывает все вызовы через общий `api.{get,post,patch,delete}` из
 * `apps/web/src/api.ts` — оттуда же приходит JWT из `localStorage.token`,
 * refresh на 401 и единая error-трансляция в `ApiError`. Здесь только
 * типизированные обёртки и URL-строки.
 *
 * # KS-2645 / ADR-054 Phase D — переключение на unified URLs
 *
 * Бэкенд унифицировал API: системные и пользовательские курсы теперь
 * на одних и тех же путях `/lessons/{courses,lessons,steps,progress}`,
 * различение по `course.ownerId` (system vs user). Старые легаси-пути
 * `/lessons/user-*` пока работают через alias (Phase E их уберёт).
 *
 * Маппинг legacy → unified:
 *   /user-courses                              → /courses?mine=1|0
 *   /user-courses/:slug                        → /courses/:slug
 *   /user-courses (POST/PATCH/DELETE)          → /courses
 *   /user-courses/:id/lessons                  → /courses/:id/lessons
 *   /user-lessons/:id                          → /lessons/:id
 *   /user-lessons/:id/steps                    → /lessons/:id/steps
 *   /user-lessons/:id/steps/reorder            → /lessons/:id/steps/reorder
 *   /user-lesson-steps/:id                     → /steps/:id
 *   /user-progress/lessons/:id/step|complete   → /progress/lessons/:id/step|complete
 *   /user-progress/{courses,lessons}/:id       → /progress/{courses,lessons}/:id
 *
 * Исключения (НЕ унифицированы — пока на legacy URLs):
 *   /user-courses/authors  — публичная витрина авторов;
 *   /user-courses/enrolled — список курсов, на которые юзер записан.
 * Эти два будут унифицированы позже; пока остаются на legacy путях,
 * чтобы не блокировать Phase D.
 */

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
  /**
   * GET /lessons/courses?mine=1|0 — список моих или публичных
   * пользовательских курсов (ADR-054 unified). Бэк отдаёт:
   *   `mine=1` — все курсы, owned юзером (любой видимости);
   *   `mine=0` — публичные курсы других авторов.
   * По умолчанию (`scope=own` или вообще без params) — `mine=1`.
   */
  list(params?: ListUserCoursesParams): Promise<UserCourseListResponse> {
    const mine = params?.scope === 'public' ? '0' : '1';
    const qs = toQueryString({ mine });
    return api.get<UserCourseListResponse>(`${BASE}/courses${qs}`);
  },

  /**
   * GET /lessons/courses?mine=0&limit=N — последние публичные
   * курсы любых авторов (KS-1918 / KS-1919). Sort `updatedAt DESC`
   * на BE. JWT нужен — без авторизации чужие курсы не отдаются.
   */
  listLatest(opts: { limit: number }): Promise<UserCourseListResponse> {
    const qs = toQueryString({
      mine: '0',
      limit: String(opts.limit),
    });
    return api.get<UserCourseListResponse>(`${BASE}/courses${qs}`);
  },

  /**
   * GET /lessons/user-courses/authors — авторы с публичными
   * курсами (KS-1918 / KS-1919 + KS-1920). НЕ унифицирован в Phase D
   * (ADR-054): эндпоинт остаётся на legacy URL до Phase E.
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
   * GET /lessons/user-courses/enrolled — курсы, которые юзер
   * проходит (или прошёл), но НЕ владеет ими (KS-1889 / KS-1890).
   * НЕ унифицирован в Phase D (ADR-054): эндпоинт остаётся на legacy
   * URL до Phase E.
   */
  listEnrolled(): Promise<UserEnrolledCoursesListResponse> {
    return api.get<UserEnrolledCoursesListResponse>(
      `${BASE}/user-courses/enrolled`,
    );
  },

  /** GET /lessons/courses/:slug — курс + уроки + прогресс. */
  getBySlug(slug: string): Promise<UserCourseWithLessonsResponse> {
    return api.get<UserCourseWithLessonsResponse>(
      `${BASE}/courses/${encodeURIComponent(slug)}`,
    );
  },

  /** POST /lessons/courses — создать курс. */
  create(body: CreateUserCourseRequest): Promise<UserCourseDto> {
    return api.post<UserCourseDto>(`${BASE}/courses`, body);
  },

  /** PATCH /lessons/courses/:id — обновить курс. */
  update(id: string, body: UpdateUserCourseRequest): Promise<UserCourseDto> {
    return api.patch<UserCourseDto>(
      `${BASE}/courses/${encodeURIComponent(id)}`,
      body,
    );
  },

  /** DELETE /lessons/courses/:id — удалить курс со всеми уроками/шагами. */
  delete(id: string): Promise<void> {
    return api.delete<void>(
      `${BASE}/courses/${encodeURIComponent(id)}`,
    );
  },

  // ─── Lessons (вложены в курс) ───────────────────────────────────────

  /** POST /lessons/courses/:id/lessons — создать урок в курсе. */
  createLesson(
    courseId: string,
    body: CreateUserLessonRequest,
  ): Promise<UserLessonDto> {
    return api.post<UserLessonDto>(
      `${BASE}/courses/${encodeURIComponent(courseId)}/lessons`,
      body,
    );
  },

  /**
   * GET /lessons/user-lessons/:id — урок + шаги + прогресс.
   *
   * KS-2645 / Phase D исключение: GET-роут пользовательского урока
   * на unified пути (`/lessons/lessons/:id`) отдаёт 404 —
   * `LessonsController.getLesson` ищет lesson только в системной
   * таблице. PATCH/DELETE/POST steps на тот же URL работают, но
   * GET — нет. Пока остаёмся на legacy URL до полного перевода
   * (предположительно Phase E или отдельная backend-задача).
   */
  getLesson(id: string): Promise<UserLessonWithStepsResponse> {
    return api.get<UserLessonWithStepsResponse>(
      `${BASE}/user-lessons/${encodeURIComponent(id)}`,
    );
  },

  /** PATCH /lessons/lessons/:id — переименовать / переставить. */
  updateLesson(
    id: string,
    body: UpdateUserLessonRequest,
  ): Promise<UserLessonDto> {
    return api.patch<UserLessonDto>(
      `${BASE}/lessons/${encodeURIComponent(id)}`,
      body,
    );
  },

  /** DELETE /lessons/lessons/:id — удалить урок. */
  deleteLesson(id: string): Promise<void> {
    return api.delete<void>(
      `${BASE}/lessons/${encodeURIComponent(id)}`,
    );
  },

  // ─── Steps (вложены в урок) ─────────────────────────────────────────

  /** POST /lessons/lessons/:id/steps — создать шаг. */
  createStep(
    lessonId: string,
    body: CreateUserLessonStepRequest,
  ): Promise<UserLessonStepDto> {
    return api.post<UserLessonStepDto>(
      `${BASE}/lessons/${encodeURIComponent(lessonId)}/steps`,
      body,
    );
  },

  /** PATCH /lessons/steps/:id — обновить payload / order. */
  updateStep(
    id: string,
    body: UpdateUserLessonStepRequest,
  ): Promise<UserLessonStepDto> {
    return api.patch<UserLessonStepDto>(
      `${BASE}/steps/${encodeURIComponent(id)}`,
      body,
    );
  },

  /** DELETE /lessons/steps/:id — удалить шаг. */
  deleteStep(id: string): Promise<void> {
    return api.delete<void>(
      `${BASE}/steps/${encodeURIComponent(id)}`,
    );
  },

  /**
   * POST /lessons/lessons/:id/steps/reorder — массовая
   * перестановка порядка шагов в уроке в одной транзакции (ADR §2.5).
   */
  reorderSteps(
    lessonId: string,
    body: ReorderUserStepsRequest,
  ): Promise<void> {
    return api.post<void>(
      `${BASE}/lessons/${encodeURIComponent(lessonId)}/steps/reorder`,
      body,
    );
  },

  // ─── Progress (BE-4, KS-1833) ───────────────────────────────────────

  /**
   * POST /lessons/progress/lessons/:userLessonId/step — отметить
   * состояние шага. `userLessonId` — URL-параметр, тело — только
   * `{stepId, state}`. Унифицированный путь работает для system и user
   * курсов (различие через ownerId на бэке).
   */
  updateStepProgress(
    userLessonId: string,
    body: Pick<UpdateUserStepProgressRequest, 'stepId' | 'state'>,
  ): Promise<UserLessonPlayProgressDto> {
    return api.post<UserLessonPlayProgressDto>(
      `${BASE}/progress/lessons/${encodeURIComponent(userLessonId)}/step`,
      body,
    );
  },

  /**
   * POST /lessons/progress/lessons/:userLessonId/complete — финальное
   * завершение урока с overall `score` (ADR-026 §2.1 — SM-2 к
   * пользовательским курсам не подключён; `score` 0..1).
   */
  completeLesson(
    userLessonId: string,
    body: Pick<CompleteUserLessonRequest, 'score'>,
  ): Promise<UserCoursePlayProgressDto> {
    return api.post<UserCoursePlayProgressDto>(
      `${BASE}/progress/lessons/${encodeURIComponent(userLessonId)}/complete`,
      body,
    );
  },

  /** GET /lessons/progress/courses/:userCourseId. */
  getCourseProgress(
    userCourseId: string,
  ): Promise<UserCoursePlayProgressDto | null> {
    return api.get<UserCoursePlayProgressDto | null>(
      `${BASE}/progress/courses/${encodeURIComponent(userCourseId)}`,
    );
  },

  /** GET /lessons/progress/lessons/:userLessonId. */
  getLessonProgress(
    userLessonId: string,
  ): Promise<UserLessonPlayProgressDto | null> {
    return api.get<UserLessonPlayProgressDto | null>(
      `${BASE}/progress/lessons/${encodeURIComponent(userLessonId)}`,
    );
  },
};
