import { UserRateLimitConfig } from '../../common/user-rate-limit.guard';

/**
 * Лимиты POST create-эндпоинтов user-courses (KS-1833, ADR-026 §2.2).
 *
 * Значения зафиксированы в ADR и в описании BE-6. Окно — 10 минут: это
 * баланс между anti-abuse и нормальным UX автора (серия быстрых правок
 * в редакторе не должна упираться в лимит).
 *
 * Применение — декоратором `@UserRateLimit(cfg.maxRequests, cfg.windowSec)`
 * рядом с `@UseGuards(JwtAuthGuard, UserCourseOwnerGuard, UserRateLimitGuard)`
 * на соответствующем route'е.
 *
 * BE-2 (`UserCoursesController`) навешивает эти лимиты — см. комментарий
 * в KS-1833.
 */
export const USER_COURSES_RATE_LIMITS: {
  createCourse: UserRateLimitConfig;
  addLesson: UserRateLimitConfig;
  addStep: UserRateLimitConfig;
} = {
  /** POST /lessons/user-courses — 5 запросов / 10 минут на userId. */
  createCourse: { maxRequests: 5, windowSec: 600 },
  /** POST /lessons/user-courses/:id/lessons — 30 / 10 мин на userId. */
  addLesson: { maxRequests: 30, windowSec: 600 },
  /** POST /lessons/user-lessons/:id/steps — 100 / 10 мин на userId. */
  addStep: { maxRequests: 100, windowSec: 600 },
};
