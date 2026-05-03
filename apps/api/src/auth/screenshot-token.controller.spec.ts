/**
 * KS-2303. Тесты `ScreenshotTokenController`.
 *
 * Покрытие:
 *  1. контроллер-юнит (без guard'а): 200 + JWT с `sub`/`username`,
 *     503 если аккаунта нет, expiresIn = парсенный JWT_EXPIRES_IN;
 *  2. интеграция rate-limit (`RedisRateLimitGuard` + `@RateLimit(10, 60)`):
 *     11-й запрос с того же IP в окне → 429.
 */

import {
  CanActivate,
  INestApplication,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import request from 'supertest';
import { ScreenshotTokenController } from './screenshot-token.controller';
import { PrismaService } from '../prisma/prisma.service';
import {
  RedisRateLimitGuard,
} from '../common/redis-rate-limit.guard';
import { RedisService } from '../redis/redis.service';
import { Reflector } from '@nestjs/core';
import { JwtService as RealJwtService } from '@nestjs/jwt';
import { ConfigService as RealConfigService } from '@nestjs/config';

const SCREENSHOT_USER = {
  id: '00000000-0000-4000-c000-000000000001',
  username: '__screenshot_agent',
};

function makeReq(): Request {
  return {
    headers: { 'user-agent': 'jest-test/1.0' },
    ip: '10.0.0.5',
  } as unknown as Request;
}

function makePrisma(found: typeof SCREENSHOT_USER | null): PrismaService {
  return {
    user: { findFirst: jest.fn(async () => found) },
  } as unknown as PrismaService;
}

function makeJwt(token: string): JwtService {
  return { sign: jest.fn().mockReturnValue(token) } as unknown as JwtService;
}

function makeConfig(expiresIn: string): ConfigService {
  return {
    get: (key: string, fallback?: string) =>
      key === 'JWT_EXPIRES_IN' ? expiresIn : fallback,
  } as unknown as ConfigService;
}

// ─── Юнит-уровень контроллера ─────────────────────────────────────

describe('ScreenshotTokenController — KS-2303 (unit)', () => {
  it('GWT-сценарий 1: аккаунт есть → 200 {accessToken, expiresIn=900}', async () => {
    const prisma = makePrisma(SCREENSHOT_USER);
    const jwt = makeJwt('signed.jwt.value');
    const ctrl = new ScreenshotTokenController(prisma, jwt, makeConfig('15m'));

    const result = await ctrl.issueScreenshotToken(makeReq());

    expect(result.accessToken).toBe('signed.jwt.value');
    expect(result.expiresIn).toBe(900);
    expect(jwt.sign).toHaveBeenCalledWith(
      { sub: SCREENSHOT_USER.id, username: SCREENSHOT_USER.username },
      { expiresIn: 900 },
    );
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { username: '__screenshot_agent' },
      select: { id: true, username: true },
    });
  });

  it('GWT-сценарий 2: аккаунта нет → ServiceUnavailableException, токен НЕ выдан', async () => {
    const prisma = makePrisma(null);
    const jwt = makeJwt('should-not-be-issued');
    const ctrl = new ScreenshotTokenController(prisma, jwt, makeConfig('15m'));

    await expect(ctrl.issueScreenshotToken(makeReq())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('JWT_EXPIRES_IN=1h → expiresIn=3600 (использует тот же helper, что synthetic-token)', async () => {
    const prisma = makePrisma(SCREENSHOT_USER);
    const jwt = makeJwt('jwt');
    const ctrl = new ScreenshotTokenController(prisma, jwt, makeConfig('1h'));

    const result = await ctrl.issueScreenshotToken(makeReq());
    expect(result.expiresIn).toBe(3600);
  });

  it('endpoint НЕ принимает userId — всегда фильтрует по фиксированному username', async () => {
    const prisma = makePrisma(SCREENSHOT_USER);
    const jwt = makeJwt('jwt');
    const ctrl = new ScreenshotTokenController(prisma, jwt, makeConfig('15m'));

    await ctrl.issueScreenshotToken(makeReq());

    const call = (prisma.user.findFirst as jest.Mock).mock.calls[0][0];
    expect(call.where.username).toBe('__screenshot_agent');
    // никаких полей `id`/`userId` в where не должно быть
    expect(call.where).not.toHaveProperty('id');
  });
});

// ─── Интеграция: rate-limit guard ────────────────────────────────

class AllowGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

/**
 * Имитирует Redis на счётчиках в Map. INCR + EXPIRE — в памяти.
 * EXPIRE мы игнорируем (для теста окно "вечное" — превышение всегда
 * срабатывает на 11-м запросе подряд).
 */
function makeFakeRedis() {
  const counters = new Map<string, number>();
  return {
    incr: jest.fn(async (key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    }),
    expire: jest.fn(async () => 1),
    counters,
  };
}

async function buildApp(opts: {
  prisma: PrismaService;
  jwt: JwtService;
  config: ConfigService;
  redis: ReturnType<typeof makeFakeRedis>;
}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ScreenshotTokenController],
    providers: [
      { provide: PrismaService, useValue: opts.prisma },
      { provide: RealJwtService, useValue: opts.jwt },
      { provide: RealConfigService, useValue: opts.config },
      { provide: RedisService, useValue: opts.redis },
      Reflector,
      RedisRateLimitGuard,
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

describe('ScreenshotTokenController — KS-2303 (rate-limit integration)', () => {
  let app: INestApplication;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('11-й запрос с того же IP в окне → 429 (RateLimit 10/60)', async () => {
    const prisma = makePrisma(SCREENSHOT_USER);
    const jwt = makeJwt('signed.jwt.value');
    const config = makeConfig('15m');
    const redis = makeFakeRedis();

    app = await buildApp({ prisma, jwt, config, redis });

    // 10 запросов подряд — должны проходить (200/201).
    for (let i = 1; i <= 10; i++) {
      await request(app.getHttpServer())
        .post('/internal/screenshot-token')
        .expect((res) => {
          if (res.status >= 400) {
            throw new Error(`request #${i} failed: ${res.status}`);
          }
        });
    }
    // 11-й — превысил лимит, 429.
    await request(app.getHttpServer())
      .post('/internal/screenshot-token')
      .expect(429);

    // EXPIRE поставлен ровно один раз (на 1-м запросе в окне).
    expect(redis.expire).toHaveBeenCalledTimes(1);
  });

  it('503 если аккаунт не provisioned (rate-limit guard пропускает запрос дальше)', async () => {
    const prisma = makePrisma(null);
    const jwt = makeJwt('jwt');
    const config = makeConfig('15m');
    const redis = makeFakeRedis();

    app = await buildApp({ prisma, jwt, config, redis });

    await request(app.getHttpServer())
      .post('/internal/screenshot-token')
      .expect(503);
  });

  // Подавляем неиспользованный warning на AllowGuard — оставлен на
  // случай будущей надстройки: если потребуется тестировать обход
  // конкретного guard'а, мы повторно используем его без переписывания
  // module-fixture.
  void AllowGuard;
});
