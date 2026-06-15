import type {
  ActiveCourseDto,
  ActiveCoursesResponse,
  CompleteLessonRequest,
  CompleteLessonResponse,
  CompleteUserLessonRequest,
  CourseAuthorListResponse,
  CourseLevel,
  CourseListResponse,
  CourseRecommendationResponse,
  CourseWithLessonsResponse,
  CreateUserCourseRequest,
  CreateUserLessonRequest,
  CreateUserLessonStepRequest,
  LessonStepState,
  LessonWithStepsResponse,
  PuzzleDto,
  PuzzleStepPayload,
  ReorderUserStepsRequest,
  ReviewsDueResponse,
  UpdateLessonStepRequest,
  UpdateUserCourseRequest,
  UpdateUserLessonRequest,
  UpdateUserLessonStepRequest,
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
import i18n from '../i18n';

/**
 * KS-4143: текущий язык интерфейса для проброса в GET-запросы lessons.
 * После KS-4140 каталог открыт гостям — у них нет `User.locale` на
 * бэке, и без явной подсказки backend отдавал русские тексты по
 * дефолту. Передаём `i18n.language` (`ru` или `en`); если приходит
 * с region-кодом (`en-US`), отрезаем до базового.
 */
function currentLocale(): string {
  const raw = (i18n.language || 'en').toLowerCase();
  const base = raw.split('-')[0];
  return base === 'ru' ? 'ru' : 'en';
}

/**
 * HTTP-клиент модуля lessons (apps/api/src/lessons).
 *
 * # ADR-054 Phase D — единый клиент system + user курсов
 *
 * До Phase D были две параллельные обёртки:
 *   - `lessonsApi` — системные курсы (контроллер на `/lessons/*`),
 *   - `userCoursesApi` — пользовательские курсы (`/lessons/user-*`).
 *
 * KS-2645 + KS-2646 свели всё к единому набору unified URL'ов:
 *   /lessons/courses[?mine=1|0]                — list (system / user)
 *   /lessons/courses/:slug                     — getCourse (оба типа)
 *   /lessons/courses (POST/PATCH/DELETE)       — CRUD user-курса
 *   /lessons/courses/:id/lessons               — createLesson
 *   /lessons/lessons/:id (GET/PATCH/DELETE)    — урок (оба типа на чтение,
 *                                               изменения — только user)
 *   /lessons/lessons/:id/steps                 — createStep
 *   /lessons/lessons/:id/steps/reorder         — reorderSteps
 *   /lessons/steps/:id (PATCH/DELETE)          — обновление/удаление шага
 *   /lessons/progress/lessons/:id/step         — markStep (оба типа)
 *   /lessons/progress/lessons/:id/complete     — completeLesson (оба типа)
 *   /lessons/progress/{courses,lessons}/:id    — read прогресса (оба типа)
 *   /lessons/courses/authors                   — публичная витрина авторов
 *   /lessons/courses/enrolled                  — записавшиеся курсы
 *
 * Различение system vs user — по `course.ownerId`: null/undefined →
 * системный, uuid → пользовательский. UI-различия (метрики автора,
 * Public/Private бейджи) проверяют это поле.
 *
 * Эндпоинт `/lessons/recommendation` появится в L-12 (KS-1767). До тех пор
 * `getRecommendation` возвращает дефолт «beginner».
 */

const FALLBACK_RECOMMENDATION: CourseRecommendationResponse = {
  level: 'beginner' as CourseLevel,
  reason: 'default',
};

/** KS-2645 (ADR-054 Phase D): параметры унифицированного `list`. */
export interface ListLessonsCoursesParams {
  /**
   * `true` — мои user-courses (любой видимости). `false` — публичные
   * user-courses других авторов. `undefined` (по умолчанию) — системные
   * курсы (legacy `listCourses` поведение).
   */
  mine?: boolean;
  /** Лимит для публичной витрины (актуально при `mine=false`). */
  limit?: number;
}

function listQueryString(params?: Record<string, string | undefined>): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== '',
  );
  if (entries.length === 0) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of entries) qs.set(k, v as string);
  return `?${qs.toString()}`;
}

/**
 * KS-2645 (ADR-054 Phase D): унифицированный список курсов.
 *
 *   `list()`              — системные курсы (CourseListResponse).
 *   `list({mine: true})`  — мои user-courses (UserCourseListResponse).
 *   `list({mine: false})` — публичные user-courses других авторов.
 *
 * Перегрузки заданы через interface (object-literal'ы overload-сигнатуры
 * напрямую не поддерживают).
 */
interface ListFn {
  (params: ListLessonsCoursesParams & { mine: boolean }): Promise<UserCourseListResponse>;
  (params?: undefined): Promise<CourseListResponse>;
}

const list: ListFn = ((
  params?: ListLessonsCoursesParams,
): Promise<CourseListResponse | UserCourseListResponse> => {
  if (params?.mine !== undefined) {
    const qs = listQueryString({
      mine: params.mine ? '1' : '0',
      limit: params.limit !== undefined ? String(params.limit) : undefined,
      locale: currentLocale(),
    });
    return api.get<UserCourseListResponse>(`/lessons/courses${qs}`);
  }
  return api.get<CourseListResponse>(
    `/lessons/courses?locale=${encodeURIComponent(currentLocale())}`,
  );
}) as ListFn;

/**
 * Параметры body для отметки шага через unified эндпоинт. Совместим
 * с обеими исторически разными формами (system/user) — KS-2646
 * привёл их к одной.
 */
type MarkStepBody = Pick<UpdateLessonStepRequest, 'stepId' | 'state' | 'score'>;

export const lessonsApi = {
  /** Системные курсы (legacy alias, использует `list()` за капотом). */
  listCourses(): Promise<CourseListResponse> {
    return api.get<CourseListResponse>(
      `/lessons/courses?locale=${encodeURIComponent(currentLocale())}`,
    );
  },

  /** См. `ListFn` выше. */
  list,

  /**
   * KS-1937 (B-5): агрегат активных курсов пользователя — system + enrolled,
   * отсортированный по `lastActivityAt` DESC.
   */
  listActiveCourses(): Promise<ActiveCourseDto[]> {
    return api
      .get<ActiveCoursesResponse>('/lessons/active-courses')
      .then((r) => r.data ?? []);
  },

  /**
   * GET /lessons/courses?mine=0&limit=N — последние публичные
   * user-courses (KS-1918 / KS-1919). Sort `updatedAt DESC` на BE.
   */
  listLatest(opts: { limit: number }): Promise<UserCourseListResponse> {
    const qs = listQueryString({
      mine: '0',
      limit: String(opts.limit),
      locale: currentLocale(),
    });
    return api.get<UserCourseListResponse>(`/lessons/courses${qs}`);
  },

  /**
   * GET /lessons/courses/authors — авторы с публичными
   * user-courses (KS-1918 / KS-1919 + KS-1920). Кэш 5 минут на BE с
   * инвалидацией при publish/unpublish.
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
    const qs = listQueryString({
      sort: opts.sort,
      limit: opts.limit !== undefined ? String(opts.limit) : undefined,
      offset: opts.offset !== undefined ? String(opts.offset) : undefined,
    });
    return api.get<CourseAuthorListResponse>(
      `/lessons/courses/authors${qs}`,
    );
  },

  /**
   * GET /lessons/courses/enrolled — курсы, которые юзер
   * проходит (или прошёл), но НЕ владеет ими (KS-1889 / KS-1890).
   * DTO включает `progress` сразу, без N+1.
   */
  listEnrolled(): Promise<UserEnrolledCoursesListResponse> {
    return api.get<UserEnrolledCoursesListResponse>(
      '/lessons/courses/enrolled',
    );
  },

  /**
   * GET /lessons/courses/:slug — курс + уроки + (для user) прогресс.
   *
   * Возвращает union-DTO: для системных — `CourseWithLessonsResponse`
   * с `level/titleI18nKey/...`; для user — `UserCourseWithLessonsResponse`
   * с `ownerId/isPublic/stats`. Различение по `course.ownerId`.
   *
   * KS-4143: передаём `?locale=<lang>` явно. После KS-4140 каталог
   * открыт гостям — `User.locale` для них недоступен, и backend без
   * подсказки отдавал русский по дефолту. Для авторизованных параметр
   * не вреден (если backend учитывает `User.locale` приоритетно,
   * query будет проигнорирован).
   */
  getCourse(slug: string): Promise<CourseWithLessonsResponse> {
    return api.get<CourseWithLessonsResponse>(
      `/lessons/courses/${encodeURIComponent(slug)}?locale=${encodeURIComponent(currentLocale())}`,
    );
  },

  /**
   * KS-2645: GET /lessons/courses/:slug для пользовательского курса.
   * Тонкий typed-alias `getCourse` чтобы сразу получить
   * `UserCourseWithLessonsResponse` без явного cast'а.
   */
  getUserCourse(slug: string): Promise<UserCourseWithLessonsResponse> {
    return api.get<UserCourseWithLessonsResponse>(
      `/lessons/courses/${encodeURIComponent(slug)}?locale=${encodeURIComponent(currentLocale())}`,
    );
  },

  /** POST /lessons/courses — создать пользовательский курс. */
  createCourse(body: CreateUserCourseRequest): Promise<UserCourseDto> {
    return api.post<UserCourseDto>('/lessons/courses', body);
  },

  /** PATCH /lessons/courses/:id — обновить пользовательский курс. */
  updateCourse(
    id: string,
    body: UpdateUserCourseRequest,
  ): Promise<UserCourseDto> {
    return api.patch<UserCourseDto>(
      `/lessons/courses/${encodeURIComponent(id)}`,
      body,
    );
  },

  /**
   * DELETE /lessons/courses/:id — удалить пользовательский курс
   * со всеми уроками/шагами.
   */
  deleteCourse(id: string): Promise<void> {
    return api.delete<void>(
      `/lessons/courses/${encodeURIComponent(id)}`,
    );
  },

  /**
   * GET /lessons/lessons/:id — урок + шаги + прогресс.
   *
   * После KS-2646: работает для обоих типов курсов. Возвращаемый DTO —
   * `LessonWithStepsResponse` для системных, `UserLessonWithStepsResponse`
   * для пользовательских. Отличия в полях `lesson` (titleI18nKey vs title,
   * userCourseId vs courseId), но общая структура (lesson, steps, progress)
   * совпадает.
   */
  getLesson(lessonId: string): Promise<LessonWithStepsResponse> {
    return api.get<LessonWithStepsResponse>(
      `/lessons/lessons/${encodeURIComponent(lessonId)}?locale=${encodeURIComponent(currentLocale())}`,
    );
  },

  /**
   * KS-2645: typed-alias `getLesson` для пользовательского урока.
   */
  getUserLesson(lessonId: string): Promise<UserLessonWithStepsResponse> {
    return api.get<UserLessonWithStepsResponse>(
      `/lessons/lessons/${encodeURIComponent(lessonId)}?locale=${encodeURIComponent(currentLocale())}`,
    );
  },

  /** POST /lessons/courses/:id/lessons — создать урок в курсе. */
  createLesson(
    courseId: string,
    body: CreateUserLessonRequest,
  ): Promise<UserLessonDto> {
    return api.post<UserLessonDto>(
      `/lessons/courses/${encodeURIComponent(courseId)}/lessons`,
      body,
    );
  },

  /** PATCH /lessons/lessons/:id — переименовать / переставить урок. */
  updateLesson(
    id: string,
    body: UpdateUserLessonRequest,
  ): Promise<UserLessonDto> {
    return api.patch<UserLessonDto>(
      `/lessons/lessons/${encodeURIComponent(id)}`,
      body,
    );
  },

  /** DELETE /lessons/lessons/:id — удалить урок. */
  deleteLesson(id: string): Promise<void> {
    return api.delete<void>(
      `/lessons/lessons/${encodeURIComponent(id)}`,
    );
  },

  /** POST /lessons/lessons/:id/steps — создать шаг. */
  createStep(
    lessonId: string,
    body: CreateUserLessonStepRequest,
  ): Promise<UserLessonStepDto> {
    return api.post<UserLessonStepDto>(
      `/lessons/lessons/${encodeURIComponent(lessonId)}/steps`,
      body,
    );
  },

  /**
   * PATCH /lessons/steps/:id — обновить payload / order шага в редакторе
   * пользовательского курса.
   *
   * Отличается от прогресс-метода `markStep` (отметка пользователем
   * прохождения шага) — тут редактируется сам шаг автором курса.
   */
  updateStepPayload(
    id: string,
    body: UpdateUserLessonStepRequest,
  ): Promise<UserLessonStepDto> {
    return api.patch<UserLessonStepDto>(
      `/lessons/steps/${encodeURIComponent(id)}`,
      body,
    );
  },

  /** DELETE /lessons/steps/:id — удалить шаг. */
  deleteStep(id: string): Promise<void> {
    return api.delete<void>(
      `/lessons/steps/${encodeURIComponent(id)}`,
    );
  },

  /**
   * POST /lessons/lessons/:id/steps/reorder — массовая перестановка
   * порядка шагов в одной транзакции (ADR-026 §2.5).
   */
  reorderSteps(
    lessonId: string,
    body: ReorderUserStepsRequest,
  ): Promise<void> {
    return api.post<void>(
      `/lessons/lessons/${encodeURIComponent(lessonId)}/steps/reorder`,
      body,
    );
  },

  /**
   * KS-2646: единый POST /lessons/progress/lessons/:lessonId/step —
   * отметка состояния шага пользователем. Работает для обоих типов курсов;
   * различение по lessonId (бэк сам маршрутизирует в LessonProgress vs
   * UserLessonProgress).
   *
   * `lessonId` — URL-параметр, тело — `{stepId, state, score?}`.
   * `score` опционален и предоставляется задачами/drill'ами; для текстовых
   * шагов остаётся undefined.
   */
  markStep(
    lessonId: string,
    body: MarkStepBody,
  ): Promise<UserLessonPlayProgressDto> {
    return api.post<UserLessonPlayProgressDto>(
      `/lessons/progress/lessons/${encodeURIComponent(lessonId)}/step`,
      body,
    );
  },

  /**
   * KS-2646: единый POST /lessons/progress/lessons/:lessonId/complete —
   * финальное завершение урока. Работает для обоих типов курсов.
   *
   * Возвращает union-DTO:
   *   - системные → `CompleteLessonResponse` (с SM-2 полями).
   *   - user → `UserCoursePlayProgressDto` (без SM-2; ADR-026 §2.1).
   * Caller'ы (`useLessonProgress` после слияния KS-2645) различают по
   * флагу того, был ли урок системным.
   */
  completeLesson(
    lessonId: string,
    body: CompleteLessonRequest | Pick<CompleteUserLessonRequest, 'score'>,
  ): Promise<CompleteLessonResponse | UserCoursePlayProgressDto> {
    return api.post<CompleteLessonResponse | UserCoursePlayProgressDto>(
      `/lessons/progress/lessons/${encodeURIComponent(lessonId)}/complete`,
      body,
    );
  },

  /** GET /lessons/progress/courses/:userCourseId. */
  getCourseProgress(
    courseId: string,
  ): Promise<UserCoursePlayProgressDto | null> {
    return api.get<UserCoursePlayProgressDto | null>(
      `/lessons/progress/courses/${encodeURIComponent(courseId)}`,
    );
  },

  /** GET /lessons/progress/lessons/:userLessonId. */
  getLessonProgress(
    lessonId: string,
  ): Promise<UserLessonPlayProgressDto | null> {
    return api.get<UserLessonPlayProgressDto | null>(
      `/lessons/progress/lessons/${encodeURIComponent(lessonId)}`,
    );
  },

  /**
   * SM-2 «К повторению сегодня» (L-22 / KS-1799). Бэк — KS-1798.
   * Отдаёт только уроки текущего пользователя, у которых `dueAt <= now`.
   */
  getReviewsDue(): Promise<ReviewsDueResponse> {
    return api.get<ReviewsDueResponse>('/lessons/reviews/due');
  },

  /**
   * Батч-резолвер задач для PuzzleStep (KS-1777 / KS-1780).
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

export type { LessonStepState };
