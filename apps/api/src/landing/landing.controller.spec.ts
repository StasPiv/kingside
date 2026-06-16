/**
 * KS-4264. LandingController — проверки guard'ов и rate-limit'а.
 */
import { Reflector } from '@nestjs/core';
import {
  RATE_LIMIT_KEY,
  RedisRateLimitGuard,
} from '../common/redis-rate-limit.guard';
import { LandingController } from './landing.controller';

describe('LandingController guards (KS-4264)', () => {
  const reflector = new Reflector();

  it('класс: без class-level guard', () => {
    const classGuards = reflector.get<unknown[]>('__guards__', LandingController);
    expect(classGuards).toBeUndefined();
  });

  it('getStats: метод-guard = RedisRateLimitGuard, без JwtAuthGuard', () => {
    const guards =
      reflector.get<unknown[]>(
        '__guards__',
        LandingController.prototype.getStats,
      ) ?? [];
    expect(guards).toContain(RedisRateLimitGuard);
    // Не должно быть JwtAuthGuard — эндпоинт публичный для гостей.
    const names = guards.map((g: unknown) =>
      typeof g === 'function' ? (g as { name?: string }).name : String(g),
    );
    expect(names).not.toContain('JwtAuthGuard');
  });

  it('getStats: RateLimit 60 req / 60 sec', () => {
    const limit = reflector.get<{ maxRequests: number; windowSec: number }>(
      RATE_LIMIT_KEY,
      LandingController.prototype.getStats,
    );
    expect(limit).toBeDefined();
    expect(limit.maxRequests).toBe(60);
    expect(limit.windowSec).toBe(60);
  });
});
