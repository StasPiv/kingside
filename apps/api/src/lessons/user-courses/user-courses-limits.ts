/**
 * Лимиты на количество пользовательских ресурсов (ADR-026 §2.2, KS-1830).
 *
 * Одно число в одном месте — чтобы сервис, тест и UI-подсказка «вы
 * достигли лимита курсов» брали один источник истины.
 */
export const USER_COURSES_LIMITS = {
  /** Максимум курсов у одного пользователя. */
  coursesPerUser: 20,
  /** Максимум уроков в одном курсе. */
  lessonsPerCourse: 30,
  /** Максимум шагов в одном уроке. */
  stepsPerLesson: 50,
  // ─── Custom puzzle (ADR-029, KS-1908) ─────────────────────────
  /** Максимум авторских задач в одном `puzzle`-шаге (mode=custom). */
  customPuzzlesPerStep: 20,
  /** Максимум ходов в `solutionMoves` одной авторской задачи. */
  customPuzzleSolutionMoves: 40,
  /** Максимум авторских тегов в одной задаче (`themes[]`). */
  customPuzzleThemes: 5,
  /** Максимальная длина одного тега. */
  customPuzzleThemeLength: 30,
  /** Максимальная длина авторской подписи (`caption`). */
  customPuzzleCaptionLength: 200,
} as const;

/**
 * Whitelist типов шагов, разрешённых в пользовательских курсах.
 * Держится на уровне API (discriminator DTO + проверка в сервисе).
 *
 * НЕ Prisma enum: добавление нового типа не должно тянуть миграцию БД
 * (ADR-026 §2.4).
 *
 * KS-2569: добавлен `quiz` (ADR-049 Tier 1 #1) — переиспользуем
 * системный `QuizStepPayloadDto` без отдельного user-варианта,
 * anti-abuse лимиты на `questions.length` пока не вводим
 * (открытый вопрос ADR-049 §2.4).
 */
export const ALLOWED_USER_STEP_TYPES = [
  'text',
  'puzzle',
  'endgame_drill',
  'quiz',
] as const;

export type AllowedUserStepType = (typeof ALLOWED_USER_STEP_TYPES)[number];
