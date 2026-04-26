import { Reflector } from '@nestjs/core';
import { LessonsAdminController } from './lessons-admin.controller';
import { LessonsAdminLessonsController } from './lessons-admin-lessons.controller';
import { LessonsAdminStepsController } from './lessons-admin-steps.controller';
import { USER_RATE_LIMIT_KEY } from '../../common/user-rate-limit.guard';
import { ADMIN_RATE_LIMIT } from './admin-rate-limit';

/**
 * KS-1972 (Admin API B-10): rate-limit декоратор должен быть применён
 * ко всем трём admin-контроллерам с одинаковыми параметрами
 * (100 запросов в минуту на пользователя). Поведение самого guard'а
 * (счётчик в Redis, 429, Retry-After) уже покрыто в
 * `apps/api/src/common/user-rate-limit.guard.spec.ts` — здесь
 * убеждаемся в конфигурации.
 */
describe('Admin API rate limit (KS-1972)', () => {
  const reflector = new Reflector();

  const controllers = [
    ['LessonsAdminController', LessonsAdminController],
    ['LessonsAdminLessonsController', LessonsAdminLessonsController],
    ['LessonsAdminStepsController', LessonsAdminStepsController],
  ] as const;

  it.each(controllers)(
    '%s имеет @UserRateLimit(100, 60)',
    (_name, ctor) => {
      const meta = reflector.get(USER_RATE_LIMIT_KEY, ctor);
      expect(meta).toEqual({
        maxRequests: ADMIN_RATE_LIMIT.maxRequests,
        windowSec: ADMIN_RATE_LIMIT.windowSec,
      });
      // sanity: концепт KS-1962 §7.7 — ровно 100/min.
      expect(meta).toEqual({ maxRequests: 100, windowSec: 60 });
    },
  );
});
