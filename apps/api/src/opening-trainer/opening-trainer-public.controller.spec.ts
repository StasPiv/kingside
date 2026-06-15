import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import {
  RATE_LIMIT_KEY,
  RedisRateLimitGuard,
} from '../common/redis-rate-limit.guard';
import { OpeningTrainerController } from './opening-trainer.controller';
import { OpeningTrainerPublicController } from './opening-trainer-public.controller';

/**
 * KS-4160 / ADR-128 §6.8.2 + §11.13.
 *
 * Защищаем три инварианта:
 *  1. `OpeningTrainerPublicController` БЕЗ JWT-guard'а ни на классе,
 *     ни на методах `GET /demo`, `GET /demo/:id` — это публичные
 *     данные, гость должен получить 200, не 401.
 *  2. На class-level стоит rate-limit (60 req/min, см. §6.8.4).
 *  3. Основной `OpeningTrainerController` (личные репертуары) ОСТАЁТСЯ
 *     под class-`JwtAuthGuard` — регрессия не должна открыть приватные
 *     эндпоинты гостю.
 */
describe('OpeningTrainerPublicController (KS-4160)', () => {
  const reflector = new Reflector();

  it('не имеет JWT/OptionalJwt-guard на классе', () => {
    const guards =
      reflector.get<unknown[]>('__guards__', OpeningTrainerPublicController) ?? [];
    expect(guards).not.toContain(JwtAuthGuard);
    expect(guards).not.toContain(OptionalJwtGuard);
  });

  it('класс-guard — только RedisRateLimitGuard', () => {
    const guards =
      reflector.get<unknown[]>('__guards__', OpeningTrainerPublicController) ?? [];
    expect(guards).toContain(RedisRateLimitGuard);
  });

  it('rate-limit задан: 60 req/min на IP', () => {
    const limit = reflector.get<{ maxRequests: number; windowSec: number }>(
      RATE_LIMIT_KEY,
      OpeningTrainerPublicController,
    );
    expect(limit).toBeDefined();
    expect(limit.maxRequests).toBe(60);
    expect(limit.windowSec).toBe(60);
  });

  it('GET /demo: метод не имеет своего JWT-guard и возвращает массив', () => {
    const method = OpeningTrainerPublicController.prototype.listDemoRepertoires;
    const methodGuards = reflector.get<unknown[]>('__guards__', method) ?? [];
    expect(methodGuards).not.toContain(JwtAuthGuard);
    expect(methodGuards).not.toContain(OptionalJwtGuard);

    const controller = new OpeningTrainerPublicController();
    const result = controller.listDemoRepertoires();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
  });

  it('GET /demo/:id: метод без JWT-guard, до seed-контента (KS-31) — 404', () => {
    const method = OpeningTrainerPublicController.prototype.getDemoRepertoire;
    const methodGuards = reflector.get<unknown[]>('__guards__', method) ?? [];
    expect(methodGuards).not.toContain(JwtAuthGuard);
    expect(methodGuards).not.toContain(OptionalJwtGuard);

    const controller = new OpeningTrainerPublicController();
    expect(() => controller.getDemoRepertoire('any-id')).toThrow(NotFoundException);
  });

  it('POST /sessions: 204 no-op (§11.13), без записи и без рантайм-ошибок', () => {
    const controller = new OpeningTrainerPublicController();
    expect(() => controller.startSession({})).not.toThrow();
    expect(controller.startSession({})).toBeUndefined();
  });

  it('регрессия: приватный OpeningTrainerController сохраняет class-JwtAuthGuard', () => {
    const guards =
      reflector.get<unknown[]>('__guards__', OpeningTrainerController) ?? [];
    expect(guards).toContain(JwtAuthGuard);
  });
});
