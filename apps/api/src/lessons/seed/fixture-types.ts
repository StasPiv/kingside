/**
 * Типы для seed-фикстур раздела «Уроки».
 *
 * Shape синхронизирован с Prisma-моделями (packages/db) и shared-типами
 * (`@kingside/shared`): `StepPayload` — дискриминированный union по `type`.
 *
 * Семантика:
 * - `slug` — стабильный ключ для идемпотентного upsert (курс по
 *   `courses.slug`, урок по `lessons.course_id + slug`).
 * - `blockKey` — «блок» урока внутри курса (не таблица, а атрибут
 *   отображения — см. ADR-024 §2.1).
 * - `i18n`-ключи — строки вида `lessons.<course-slug>.<path>`. Тексты
 *   живут в `apps/web/src/i18n/*.json` / `apps/api/src/i18n/*.json`.
 * - Для удобства chess-expert в `TextStepPayload` допустим `bodyMarkdown`
 *   inline (без i18n-ключа) — сознательное отступление от ADR §2.4 для
 *   ускорения авторинга; для мультиязычных курсов перейти на `bodyI18nKey`.
 */

import type {
  CourseLevel,
  LessonKind,
  StepPayload,
} from '@kingside/shared';

export interface CourseFixture {
  slug: string;
  level: CourseLevel;
  titleKey: string;
  descriptionKey: string;
  order: number;
  isPublished: boolean;
  lessons: LessonFixture[];
}

export interface LessonFixture {
  slug: string; // уникален в рамках курса
  order: number;
  blockKey: string; // напр. "rules" | "basic-mates" | ...
  kind: LessonKind;
  titleKey: string;
  summaryKey: string;
  estMinutes?: number; // default 10
  isPublished: boolean;
  steps: StepFixture[];
}

export interface StepFixture {
  /** Стабильный id шага внутри урока (для `stepsState` в прогрессе). */
  id: string;
  order: number;
  payload: StepPayload;
}
