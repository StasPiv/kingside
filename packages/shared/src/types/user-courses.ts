/**
 * Shared types for User Courses (ADR-026, KS-1827 / KS-1829).
 *
 * Пользовательские курсы — параллельное дерево моделям Course/Lesson/
 * LessonStep. Отличия от системных (`./lessons.ts`):
 *
 *   1. Контент — plain-text, без i18n (поля `title`, `description`,
 *      `TextStepPayload.bodyMarkdown` — в языке автора).
 *   2. Публикация — `isPublic` (доступ по прямой ссылке), не `isPublished`.
 *   3. `UserLessonStep.type` — whitelist из 3 значений (`UserStepType`),
 *      хотя сам `payload` — тот же shared-union `StepPayload` (мы лишь
 *      ограничиваем, какие подтипы разрешены в пользовательских курсах).
 *      Ограничение держится на API-валидации (BE-3), не на Prisma-enum —
 *      добавление 4-го типа не должно тащить миграцию БД (ADR-026 §2.4).
 *
 * `StepPayload` союз НЕ урезается и не переопределяется: он общий для
 * системных и пользовательских шагов (ADR-026 Приложение A).
 */

import type { CourseCardFields, LessonStepState, StepPayload } from './lessons.js';

// ─── Discriminators ───────────────────────────────────────────────────

/**
 * Whitelist типов шагов в пользовательских курсах (ADR-026 §2.3).
 *
 * Новый тип добавляется в 3 места: этот union, `ALLOWED_USER_STEP_TYPES`
 * в API-DTO (BE-3) и UI `<select>` редактора шага (FE-2).
 *
 * KS-2570: добавлен `'quiz'` (ADR-049 Tier 1 #2). Backend-whitelist
 * расширен в KS-2569.
 *
 * KS-3179 (ADR-072 §7 S1): добавлен `'game'` — read-only просмотр
 * партии. Backend-whitelist (`ALLOWED_USER_STEP_TYPES`) и UI-редактор
 * расширяются отдельными тикетами (KS-3180+).
 */
export type UserStepType =
  | 'text'
  | 'puzzle'
  | 'endgame_drill'
  | 'quiz'
  | 'game';

// ─── Core DTOs ────────────────────────────────────────────────────────

/** Итоговый DTO курса (без вложенных уроков). */
export interface UserCourseDto {
  id: string;
  ownerId: string;
  slug: string;
  title: string;
  description: string | null;
  isPublic: boolean;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  updatedAt: string;
  /** Денормализованный счётчик уроков (для карточек в списке). */
  lessonCount: number;
  /**
   * Метрики прохождений (KS-1885). Поле возвращается ТОЛЬКО владельцу
   * курса (или admin'у в будущем). Не-владельцу — `undefined`, чтобы
   * не утекали пользовательские агрегаты с публичных курсов.
   *
   * Считается как:
   *   - `enrolledCount`     = COUNT(UserCoursePlayProgress) по `userCourseId`
   *   - `completedCount`    = COUNT(...)  WHERE `completedAt IS NOT NULL`
   *   - `inProgressCount`   = `enrolledCount - completedCount`
   *
   * Свежесть — на момент запроса. Кешируем на FE столько же, сколько
   * сам DTO; refresh — re-fetch.
   */
  stats?: UserCourseStatsDto;
}

export interface UserCourseStatsDto {
  enrolledCount: number;
  completedCount: number;
  inProgressCount: number;
}

export interface UserLessonDto {
  id: string;
  userCourseId: string;
  order: number;
  title: string;
  estMinutes: number | null;
  stepCount: number;
}

export interface UserLessonStepDto {
  id: string;
  userLessonId: string;
  order: number;
  type: UserStepType;
  /** Дискриминирован по `type` — см. `StepPayload` в `./lessons.ts`. */
  payload: StepPayload;
}

// ─── Composite responses ──────────────────────────────────────────────

/** GET /api/lessons/user-courses — список (свои или публичные). */
export interface UserCourseListResponse {
  data: UserCourseDto[];
}

/**
 * Запись секции «Курсы, которые я прохожу» (KS-1889).
 *
 * Это всегда чужие курсы (`course.ownerId !== currentUserId`), у
 * которых у текущего пользователя есть `UserCoursePlayProgress`.
 * Прогресс встроен прямо в DTO — фронт без второго запроса умеет
 * показать бейдж «✓ Пройден» (KS-1882) и долю прохождения.
 *
 * Отличия от `UserCourseDto`:
 *   - `stats` всегда отсутствует — это студенческая вкладка, авторские
 *     метрики прохождений тут не нужны (security-параллель: stats
 *     приватны для не-owner'ов, см. KS-1885);
 *   - `progress` гарантированно есть (запись в выборку попала именно
 *     потому, что у юзера progress существует).
 */
export interface UserEnrolledCourseDto
  extends Omit<UserCourseDto, 'stats'>,
    CourseCardFields {
  progress: UserCoursePlayProgressDto;
}

/** GET /api/lessons/user-courses/enrolled — список enrolled-not-owned. */
export interface UserEnrolledCoursesListResponse {
  data: UserEnrolledCourseDto[];
}

/**
 * Автор пользовательских курсов на витрине лобби `/lessons` и в табе
 * Authors на `/players` (ADR-030 / KS-1918).
 *
 * Считается агрегатом по `UserCourse where isPublic=true`, group by
 * `ownerId`. Все поля — деривативные, отдельной таблицы «author» в БД
 * нет.
 */
export interface CourseAuthorDto {
  user: {
    id: string;
    username: string;
    /** Опционально — добавится, когда поле появится в `User`-схеме. */
    displayName?: string | null;
    /** Опционально — то же. */
    avatarUrl?: string | null;
  };
  /** Сколько публичных курсов у автора. */
  publicCoursesCount: number;
  /** ISO-8601 от MAX(updatedAt) последнего публичного курса автора. */
  lastCourseUpdatedAt: string;
  /** Slug последнего обновлённого публичного курса (для прямой ссылки). */
  latestCourseSlug: string;
  /** Title последнего обновлённого публичного курса (teaser). */
  latestCourseTitle: string;
}

/**
 * GET /api/lessons/user-courses/authors — список авторов с агрегатом.
 * Публичный (без JWT). Sort/limit/offset параметризуются query.
 */
export interface CourseAuthorListResponse {
  data: CourseAuthorDto[];
  /**
   * Всего авторов с публичными курсами (для UI «Showing N of M»).
   * Не равно `data.length` при пагинации.
   */
  total: number;
}

/** GET /api/lessons/user-courses/:slug — курс + список уроков (короткий). */
export interface UserCourseWithLessonsResponse {
  course: UserCourseDto;
  lessons: UserLessonDto[];
  /** Прогресс текущего пользователя, если он начал курс. */
  progress: UserCoursePlayProgressDto | null;
}

/** GET /api/lessons/user-lessons/:id — урок + все шаги + прогресс. */
export interface UserLessonWithStepsResponse {
  lesson: UserLessonDto;
  steps: UserLessonStepDto[];
  progress: UserLessonPlayProgressDto | null;
}

// ─── Progress DTOs ────────────────────────────────────────────────────

export interface UserCoursePlayProgressDto {
  userCourseId: string;
  completedLessonsCount: number;
  /** ISO-8601. */
  startedAt: string;
  /** ISO-8601. */
  lastActivityAt: string;
  /** ISO-8601 или null, если ещё не завершён. */
  completedAt: string | null;
  /**
   * KS-1955: первый незавершённый урок курса по `order` ASC. `null`,
   * если курс пройден. У пользовательских курсов i18n не используется
   * — заголовок хранится строкой в `UserLesson.title`.
   */
  currentLessonSlug: string | null;
  currentLessonTitle: string | null;
  /** 1-based номер текущего урока — для «Урок N из M». */
  currentLessonOrder: number | null;
}

export interface UserLessonPlayProgressDto {
  userLessonId: string;
  completedStepsCount: number;
  totalSteps: number;
  /**
   * Поштучное состояние шагов урока (KS-1879). Ключ — `stepId`,
   * значение — `LessonStepState` (`pending` означает «явно не отмечен»;
   * сервер обычно сюда `pending` не пишет, шаги без записи считаются
   * `pending` по умолчанию). Используется фронтом для восстановления
   * прогресса при повторном открытии урока — без него `completedStepsCount`
   * показывает только агрегат, без понимания «какие именно шаги
   * сделаны».
   *
   * Backward-compat: для строк, существующих в БД до миграции
   * KS-1879, поле возвращается как `{}` (default `'{}'::jsonb` на
   * уровне Postgres).
   */
  stepsState: Record<string, LessonStepState>;
  /** ISO-8601. */
  startedAt: string;
  /** ISO-8601. */
  lastActivityAt: string;
  /** ISO-8601 или null, если ещё не завершён. */
  completedAt: string | null;
}

// ─── Request bodies ───────────────────────────────────────────────────

export interface CreateUserCourseRequest {
  title: string;
  description?: string;
  isPublic?: boolean;
  /**
   * Опциональный кастомный slug. Если не передан — генерируется из
   * title сервером. Правила для явного slug: `[a-z0-9-]+`, длина 3..80,
   * без ведущих/замыкающих дефисов и без `--` (ADR-026 §2.5).
   */
  slug?: string;
}

export interface UpdateUserCourseRequest {
  title?: string;
  description?: string | null;
  isPublic?: boolean;
}

export interface CreateUserLessonRequest {
  title: string;
  estMinutes?: number;
}

export interface UpdateUserLessonRequest {
  title?: string;
  estMinutes?: number | null;
  /** Для перестановки порядка уроков внутри курса. */
  order?: number;
}

export interface CreateUserLessonStepRequest {
  type: UserStepType;
  payload: StepPayload;
}

export interface UpdateUserLessonStepRequest {
  payload?: StepPayload;
  order?: number;
}

/**
 * POST /api/lessons/user-lessons/:id/steps/reorder — массовый апдейт
 * `order` в одной транзакции. `ids` — массив id шагов в нужном порядке
 * (0, 1, 2, …). Атомарность важна: при сбое — откат, иначе UI увидит
 * «полу-переставленный» список.
 */
export interface ReorderUserStepsRequest {
  ids: string[];
}

/**
 * POST /api/lessons/user-courses/:id/lessons/reorder — массовый апдейт
 * `order` уроков внутри курса (KS-1862). `ids` — массив id уроков в
 * нужном порядке (0, 1, 2, …). Все id обязаны принадлежать курсу;
 * список должен содержать все уроки курса (полная перестановка), иначе
 * сервер отвечает 400. Атомарность та же, что у `ReorderUserStepsRequest`.
 */
export interface ReorderUserLessonsRequest {
  ids: string[];
}

// ─── Progress update requests ────────────────────────────────────────

/**
 * POST /api/lessons/user-progress/lessons/:userLessonId/step — отметить
 * состояние шага. `userLessonId` идёт в path, не в body.
 */
export interface UpdateUserStepProgressRequest {
  stepId: string;
  /** Ограниченный набор — см. `LessonStepState` в `./lessons.ts`. */
  state: 'done' | 'failed' | 'skipped';
}

/**
 * POST /api/lessons/user-progress/lessons/:userLessonId/complete —
 * финальное завершение урока. Без поля `quality`, т.к. SM-2 к
 * пользовательским курсам не подключён (ADR-026 §2.1).
 */
export interface CompleteUserLessonRequest {
  /** 0..1 — доля успешных шагов (порог прохождения — ADR §2.6). */
  score: number;
}
