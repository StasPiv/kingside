import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import {
  RATE_LIMIT_KEY,
  RedisRateLimitGuard,
} from '../common/redis-rate-limit.guard';
import { LecturesController } from './lectures.controller';

/**
 * KS-4188 / ADR-128 §7.6.1.6 + §6.8.2/§6.8.4. Гард-инварианты
 * публичного эндпоинта `GET /lectures/public`:
 *  - на классе ничего не висит (контроллер без class-guard, ADR-128 §6.8.2),
 *  - на методе `listPublic` — `OptionalJwtGuard` + `RedisRateLimitGuard`,
 *  - rate-limit ровно 60 / 60 сек,
 *  - JWT-only методы (`create`, `update`, `start` …) сохраняют `JwtAuthGuard`.
 */
describe('LecturesController — listPublic guards (KS-4188)', () => {
  const reflector = new Reflector();

  it('класс: без class-level guard', () => {
    const classGuards = reflector.get<unknown[]>(
      '__guards__',
      LecturesController,
    );
    // @Controller() без UseGuards — метаданных нет вовсе.
    expect(classGuards).toBeUndefined();
  });

  it('listPublic: метод-guard'+'ы = OptionalJwtGuard + RedisRateLimitGuard', () => {
    const guards =
      reflector.get<unknown[]>(
        '__guards__',
        LecturesController.prototype.listPublic,
      ) ?? [];
    expect(guards).toContain(OptionalJwtGuard);
    expect(guards).toContain(RedisRateLimitGuard);
    expect(guards).not.toContain(JwtAuthGuard);
  });

  it('listPublic: RateLimit = 60 req / 60 sec', () => {
    const limit = reflector.get<{ maxRequests: number; windowSec: number }>(
      RATE_LIMIT_KEY,
      LecturesController.prototype.listPublic,
    );
    expect(limit).toBeDefined();
    expect(limit.maxRequests).toBe(60);
    expect(limit.windowSec).toBe(60);
  });

  it('регрессия: JWT-only методы (create, update, start, listMyLectures) сохраняют JwtAuthGuard', () => {
    for (const method of [
      'create',
      'update',
      'start',
      'cancel',
      'remove',
      'forceEnd',
      'listMyLectures',
    ] as const) {
      const guards =
        reflector.get<unknown[]>(
          '__guards__',
          (LecturesController.prototype as unknown as Record<string, Function>)[
            method
          ],
        ) ?? [];
      expect(guards).toContain(JwtAuthGuard);
    }
  });

  it('регрессия: гость-доступные методы под OptionalJwtGuard', () => {
    for (const method of [
      'getById',
      'getRecording',
      'listByCoach',
      'scheduleByCoach',
    ] as const) {
      const guards =
        reflector.get<unknown[]>(
          '__guards__',
          (LecturesController.prototype as unknown as Record<string, Function>)[
            method
          ],
        ) ?? [];
      expect(guards).toContain(OptionalJwtGuard);
      expect(guards).not.toContain(JwtAuthGuard);
    }
  });
});
