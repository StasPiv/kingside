import type {
  ActiveCourseDto,
  ActiveCoursesResponse,
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
  UserCourseListResponse,
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

/**
 * KS-2102: убрана передача `?lang=` в API. Backend (KS-2101) теперь
 * читает язык из `User.locale` (anonymous → ru fallback). Query
 * `?lang=` бэкенд молча игнорирует. Источник истины — настройка
 * профиля; смена через `PATCH /users/me/settings { locale }`
 * (см. `MainLayout` language switcher).
 *
 * Сигнатуры функций упрощены: lang-аргумент удалён, чтобы
 * случайно не передавать «локальный» i18next.language вместо
 * серверной локали.
 */

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
 * DTO различаются: системные ответ — `CourseListResponse`, user-courses —
 * `UserCourseListResponse` с `ownerId/isPublic/lessonCount/stats`.
 * Различение на стороне вызывающего по `course.ownerId` (null/undefined
 * → системный).
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
    });
    return api.get<UserCourseListResponse>(`/lessons/courses${qs}`);
  }
  return api.get<CourseListResponse>('/lessons/courses');
}) as ListFn;

export const lessonsApi = {
  listCourses(): Promise<CourseListResponse> {
    return api.get<CourseListResponse>('/lessons/courses');
  },

  /** См. `ListFn` выше. */
  list,

  /**
   * KS-1937 (B-5): агрегат активных курсов пользователя — system + enrolled,
   * отсортированный по `lastActivityAt` DESC. Сервер фильтрует по
   * `progress != null && completedAt == null`, фронт получает уже готовый
   * список и НЕ дублирует фильтрацию.
   *
   * Используется в `useLessonsHeroContext` (KS-1938) и
   * `MyActiveCoursesPage` (KS-1941) — заменяет пару
   * `listCourses + listEnrolled` (KS-1957 / F-12).
   */
  listActiveCourses(): Promise<ActiveCourseDto[]> {
    return api
      .get<ActiveCoursesResponse>('/lessons/active-courses')
      .then((r) => r.data ?? []);
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
