/**
 * KS-1972 (Admin API B-10) — общий лимит для admin-эндпоинтов.
 *
 * 100 запросов в минуту на пользователя (per-user, не per-IP), как
 * в концепте KS-1962 §7.7. Применяется ко всем
 * `LessonsAdminController` / `LessonsAdminLessonsController` /
 * `LessonsAdminStepsController`.
 *
 * Хранится отдельной константой, чтобы три контроллера ссылались
 * на один и тот же лимит — не разойдётся при будущих правках.
 */
export const ADMIN_RATE_LIMIT = {
  maxRequests: 100,
  windowSec: 60,
} as const;
