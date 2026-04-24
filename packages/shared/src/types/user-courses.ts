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

import type { StepPayload } from './lessons.js';

// ─── Discriminators ───────────────────────────────────────────────────

/**
 * Whitelist типов шагов в пользовательских курсах (MVP, ADR-026 §2.3).
 *
 * Новый тип добавляется в 3 места: этот union, `ALLOWED_USER_STEP_TYPES`
 * в API-DTO (BE-3) и UI `<select>` редактора шага (FE-2).
 */
export type UserStepType = 'text' | 'puzzle' | 'endgame_drill';

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
}

export interface UserLessonPlayProgressDto {
  userLessonId: string;
  completedStepsCount: number;
  totalSteps: number;
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
