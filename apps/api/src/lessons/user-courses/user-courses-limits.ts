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
} as const;

/**
 * Whitelist типов шагов, разрешённых в пользовательских курсах.
 * Держится на уровне API (discriminator DTO + проверка в сервисе).
 *
 * НЕ Prisma enum: добавление 4-го типа не должно тянуть миграцию БД
 * (ADR-026 §2.4).
 */
export const ALLOWED_USER_STEP_TYPES = ['text', 'puzzle', 'endgame_drill'] as const;

export type AllowedUserStepType = (typeof ALLOWED_USER_STEP_TYPES)[number];
