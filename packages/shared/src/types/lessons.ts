/**
 * Shared types for the Lessons module (MVP).
 *
 * Источники истины:
 *   - docs/architecture/lessons-module.md — архитектурный обзор
 *   - docs/architecture/lessons-roadmap.md — план декомпозиции (L-02)
 *   - docs/adr/0024-lessons-module.md — ADR (в работе, L-01); финальная
 *     сверка типов — после его утверждения
 *
 * Контракт для REST API (apps/api) и фронта (apps/web). Бэкендовые
 * class-validator DTO должны повторять поля этих типов (packages/shared —
 * единственный источник истины для shape'а).
 *
 * JSONB `payload` шагов валидируется на бэке class-validator'ом и на
 * входе seed-линтером, а тут — дискриминированным union'ом `StepPayload`
 * по полю `type`.
 */

import type { PuzzleTheme } from './puzzle.js';

// ─── Common ──────────────────────────────────────────────────────────

/** Уровни курсов (соответствует `Course.level`). */
export type CourseLevel = 'beginner' | 'intermediate' | 'advanced';

/**
 * «Тип» урока (атрибут `Lesson.kind`) — подсказывает фронту, какой основной
 * контент в уроке. Реальный рендер определяют шаги (`LessonStep.type`).
 */
export type LessonKind =
  | 'theory'
  | 'tactics_set'
  | 'endgame_set'
  | 'opening_line'
  | 'game_review'
  | 'quiz';

/**
 * Типы шагов. В MVP реально отрендерены `text`, `puzzle`, `quiz`
 * (см. lessons-roadmap.md §1). Остальные (`position`, `game_review`,
 * `video`) зарезервированы — их payload'ы объявлены как «заглушки»,
 * чтобы бэк-валидация и фронт-диспетчер имели единый словарь `type`'ов.
 */
export type LessonStepType =
  | 'text'
  | 'puzzle'
  | 'quiz'
  | 'position'
  | 'game_review'
  | 'video';

/** Статус прохождения шага внутри урока (агрегат в `UserLessonProgress.stepsState`). */
export type LessonStepState = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';

// ─── Step payloads (discriminated union by `type`) ───────────────────

/**
 * Курируемый набор задач внутри `PuzzleStep`. В MVP поддерживается один
 * из двух режимов: либо явный список id, либо фильтр `themes+rating`.
 */
export type PuzzleStepSelection =
  | {
      mode: 'ids';
      puzzleIds: string[];
    }
  | {
      mode: 'filter';
      themes: PuzzleTheme[];
      ratingMin?: number;
      ratingMax?: number;
      /** Сколько задач выдавать в рамках шага. */
      limit: number;
    };

/**
 * Статья + FEN-диаграммы (read-only). Контент — markdown.
 *
 * ## Синтаксис FEN внутри markdown
 *
 * Поддерживается два варианта встраивания диаграмм (эквивалентны, выбор
 * на усмотрение автора урока):
 *
 * ### 1. Reference-плейсхолдер `{{diagram:N}}`
 *
 * `N` — индекс в `payload.diagrams` (начиная с 0). Пример:
 *
 * ```markdown
 * Рассмотрим начальную позицию:
 *
 * {{diagram:0}}
 *
 * Белые ходят первыми…
 * ```
 *
 * `payload.diagrams[0]` содержит `{ fen, caption?, orientation? }`.
 *
 * ### 2. Inline fenced-блок ```fen [orientation]```
 *
 * `orientation` — `white` или `black`, по умолчанию `white`. FEN-строка
 * идёт первой непустой строкой блока, опциональная подпись — на отдельной
 * строке после префикса `caption:`. Пример:
 *
 * ````markdown
 * Защита Каро-Канн начинается так:
 *
 * ```fen
 * rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2
 * caption: После 1.e4 c6
 * ```
 * ````
 *
 * Inline-форма удобна для одноразовых диаграмм (не нужно описывать их в
 * `payload.diagrams`). Reference-форма удобна, если на одну диаграмму
 * ссылаются несколько раз или её описывают декларативно (полезно для
 * seed-линтера и переводов).
 *
 * Реализация — `apps/web/src/components/lessons/steps/TextStep.tsx`
 * (KS-1763 / L-08).
 */
export interface TextStepPayload {
  type: 'text';
  /** i18n-ключ тела статьи (markdown) либо сам markdown, если `inline` */
  bodyI18nKey?: string;
  /** Альтернатива `bodyI18nKey`: прямой markdown (для простых seed'ов). */
  bodyMarkdown?: string;
  /**
   * FEN-диаграммы, встроенные в статью. Рендерятся read-only, порядок
   * совпадает с порядком плейсхолдеров вида `{{diagram:0}}` в markdown.
   */
  diagrams?: Array<{
    fen: string;
    caption?: string;
    /** Какой цвет снизу при рендере диаграммы. */
    orientation?: 'white' | 'black';
  }>;
}

/** Решение тактических задач (обёртка над `PuzzleBoard`/PuzzleModule). */
export interface PuzzleStepPayload {
  type: 'puzzle';
  selection: PuzzleStepSelection;
  /** Минимальное число решённых для зачёта шага (по умолчанию = все). */
  minSolved?: number;
}

/** Мини-тест с мульти-выбором (локальная проверка на фронте в MVP). */
export interface QuizStepPayload {
  type: 'quiz';
  questions: QuizQuestion[];
  /** Порог «зачёт» по шагу: доля правильных ответов 0..1 (по умолчанию 0.7). */
  passThreshold?: number;
}

export interface QuizQuestion {
  id: string;
  /** i18n-ключ текста вопроса. */
  promptI18nKey: string;
  /** Опционально: FEN-диаграмма под вопросом. */
  fen?: string;
  options: QuizOption[];
  /** id правильного варианта(ов). */
  correctOptionIds: string[];
  /** true — несколько правильных; false — один. */
  multi?: boolean;
  /** i18n-ключ разбора после ответа. */
  explanationI18nKey?: string;
}

export interface QuizOption {
  id: string;
  labelI18nKey: string;
}

// ─── Step payloads: заделы под следующие итерации (пустышки) ──────────

/**
 * Интерактивная позиция (итерация 2, L-23). В MVP тип зарезервирован,
 * payload — минимальный (проверка ожидаемых UCI-ходов), чтобы бэк-валидация
 * и фронт-диспетчер имели словарь `type`'ов, но детали контракта ещё
 * не зафиксированы — шейп будет уточнён в ADR итерации 2.
 */
export interface PositionStepPayload {
  type: 'position';
  fen: string;
  /** Ожидаемые ходы (UCI). Принимается любой из списка. */
  expectedMoves: string[];
  orientation?: 'white' | 'black';
}

/**
 * Разбор своей партии (итерация 3, L-30). Заглушка — детали payload'а
 * зафиксирует ADR итерации 3.
 */
export interface GameReviewStepPayload {
  type: 'game_review';
  /** id импортированной/сыгранной партии в нашей БД. */
  gameId?: string;
  /** Либо прямой PGN, если партия не загружена. */
  pgn?: string;
}

/**
 * Видео-шаг (итерация 3, L-34). Заглушка, появится если методически
 * понадобится.
 */
export interface VideoStepPayload {
  type: 'video';
  /** Внешний URL (YouTube/Vimeo). Рендер через iframe. */
  url: string;
  titleI18nKey?: string;
}

/**
 * Дискриминированный union по полю `type`. Сужать через `switch (payload.type)`.
 */
export type StepPayload =
  | TextStepPayload
  | PuzzleStepPayload
  | QuizStepPayload
  | PositionStepPayload
  | GameReviewStepPayload
  | VideoStepPayload;

/** Алиасы под именование в ТЗ (`TextStep`/`PuzzleStep`/`QuizStep`). */
export type TextStep = TextStepPayload;
export type PuzzleStep = PuzzleStepPayload;
export type QuizStep = QuizStepPayload;
export type PositionStep = PositionStepPayload;
export type GameReviewStep = GameReviewStepPayload;
export type VideoStep = VideoStepPayload;

// ─── Domain entities (API shape, сериализовано в JSON) ────────────────

/**
 * Курс. Поля соответствуют Prisma-модели `Course` (см. lessons-module.md §2.1
 * и будущую миграцию L-03). `titleI18nKey` / `descriptionI18nKey` —
 * ссылки на словари i18n (тексты не хранятся в БД).
 */
export interface Course {
  id: string;
  slug: string;
  level: CourseLevel;
  titleI18nKey: string;
  descriptionI18nKey: string;
  order: number;
  isPublished: boolean;
  /** Сколько уроков в курсе (агрегат — не отдельная таблица). */
  lessonCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Урок. `payload` урока — параметры высокого уровня (например, подборка
 * `puzzleIds` на уровне всего урока); детализация — в `LessonStep.payload`.
 * Семантика `payload` зависит от `kind` и фиксируется отдельно в ADR-024.
 */
export interface Lesson {
  id: string;
  courseId: string;
  slug: string;
  order: number;
  kind: LessonKind;
  titleI18nKey: string;
  summaryI18nKey: string;
  /** Опциональные параметры уровня урока (подборка puzzleIds, ссылки и т. п.). */
  payload?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Шаг урока. Дискриминатор — `type`, полная shape'а payload'а — в
 * `StepPayload`. Для бэка `payload` хранится как JSONB.
 */
export interface LessonStep {
  id: string;
  lessonId: string;
  order: number;
  type: LessonStepType;
  /** Дискриминируется по `type`. */
  payload: StepPayload;
}

// ─── User progress ────────────────────────────────────────────────────

/**
 * Прогресс пользователя по курсу.
 * `startedAt`/`completedAt` — ISO-строки (в БД `DateTime`, сериализуется).
 */
export interface UserCourseProgress {
  userId: string;
  courseId: string;
  startedAt: string;
  completedAt: string | null;
  currentLessonId: string | null;
  /** Сколько уроков пройдено (для индикатора в `CoursePage`). */
  lessonsCompleted: number;
  /** Всего уроков на момент последнего апдейта — для UI, не для хранения. */
  lessonsTotal: number;
}

/**
 * Прогресс пользователя по уроку. `stepsState` — агрегат по шагам
 * (попытки задач пишутся в `PuzzleAttempt`, здесь только итоговое состояние
 * каждого шага).
 */
export interface UserLessonProgress {
  userId: string;
  lessonId: string;
  startedAt: string;
  completedAt: string | null;
  /** Итоговый балл за урок 0..1 (напр. доля пройденных шагов). */
  score: number | null;
  stepsState: Record<string, LessonStepState>;
}

// ─── REST DTOs ────────────────────────────────────────────────────────
//
// Формат путей — предположительный, уточняется в L-04. Согласование
// имён/полей — ответственность shared-пакета.

/** GET /api/lessons/courses — список курсов (без уроков). */
export interface CourseListItem {
  id: string;
  slug: string;
  level: CourseLevel;
  titleI18nKey: string;
  descriptionI18nKey: string;
  order: number;
  lessonCount: number;
  /** Прогресс текущего пользователя, если он аутентифицирован. */
  progress?: {
    lessonsCompleted: number;
    startedAt: string;
    completedAt: string | null;
    currentLessonId: string | null;
  } | null;
}

export interface CourseListResponse {
  data: CourseListItem[];
  /** Рекомендованный уровень для текущего пользователя (по ratingPuzzle). */
  recommendedLevel?: CourseLevel;
}

/** GET /api/lessons/courses/:slug — курс + короткий список уроков. */
export interface CourseWithLessonsResponse {
  course: Course;
  lessons: CourseLessonSummary[];
  progress?: UserCourseProgress | null;
}

/** Короткая сводка урока для `CoursePage`. */
export interface CourseLessonSummary {
  id: string;
  slug: string;
  order: number;
  kind: LessonKind;
  titleI18nKey: string;
  summaryI18nKey: string;
  stepCount: number;
  /** Состояние прохождения пользователем. */
  progressState: 'not_started' | 'in_progress' | 'completed';
}

/** GET /api/lessons/courses/:courseSlug/lessons/:lessonSlug — урок с шагами. */
export interface LessonWithStepsResponse {
  lesson: Lesson;
  steps: LessonStep[];
  progress?: UserLessonProgress | null;
}

/** POST /api/lessons/:lessonId/progress/start — начать/возобновить урок. */
export type StartLessonProgressResponse = UserLessonProgress;

/** POST /api/lessons/:lessonId/progress/step — обновить состояние одного шага. */
export interface UpdateLessonStepRequest {
  stepId: string;
  state: LessonStepState;
  /** Опциональные метрики шага (напр. доля верных ответов для `quiz`). */
  score?: number;
}

export type UpdateLessonStepResponse = UserLessonProgress;

/** POST /api/lessons/:lessonId/progress/complete — завершить урок (≥70%). */
export interface CompleteLessonRequest {
  /** Финальный балл 0..1 (обычно агрегат `stepsState`). */
  score: number;
}

export type CompleteLessonResponse = UserLessonProgress;

/** GET /api/lessons/recommendation — рекомендованный уровень (по `ratingPuzzle`). */
export interface CourseRecommendationResponse {
  level: CourseLevel;
  /** На чём основана рекомендация (для UI-пояснения). */
  reason: 'rating_puzzle' | 'default';
  ratingPuzzle?: number;
}
