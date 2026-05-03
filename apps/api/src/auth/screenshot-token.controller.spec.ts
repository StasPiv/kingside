/**
 * KS-2303 / KS-2305. Тесты `ScreenshotTokenController`.
 *
 * Покрытие:
 *  1. контроллер-юнит (без guard'а): 200 + JWT с `sub`/`username`,
 *     503 если аккаунта нет, expiresIn = парсенный JWT_EXPIRES_IN;
 *  2. KS-2305 — structured-log JSON-формат + Prometheus metric inc;
 *  3. интеграция rate-limit (`ScreenshotTokenRateLimitGuard` + `@RateLimit(10, 60)`):
 *     11-й запрос с того же IP в окне → 429 + structured-log
 *     `outcome=rate_limited`.
 */

import {
  CanActivate,
  INestApplication,
  Logger,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import request from 'supertest';
import {
  ScreenshotTokenController,
  ScreenshotTokenRateLimitGuard,
} from './screenshot-token.controller';
import { PrismaService } from '../prisma/prisma.service';
import { RedisRateLimitGuard } from '../common/redis-rate-limit.guard';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from '../metrics/metrics.service';
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

  // ── KS-2305: structured-log + Prometheus metric ─────────────────

  it('KS-2305: на issued — structured JSON-log + Prometheus inc', async () => {
    const prisma = makePrisma(SCREENSHOT_USER);
    const jwt = makeJwt('signed.jwt.value');
    const metrics = {
      incScreenshotTokenIssued: jest.fn(),
    } as unknown as MetricsService;
    const ctrl = new ScreenshotTokenController(
      prisma,
      jwt,
      makeConfig('15m'),
      metrics,
    );
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    const req = {
      headers: {
        'user-agent': 'screenshot-tool/2.0',
        'x-forwarded-for': '203.0.113.42, 10.0.0.1',
      },
      ip: '10.0.0.99',
    } as unknown as Request;

    await ctrl.issueScreenshotToken(req);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const message = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(message);
    expect(parsed).toMatchObject({
      event: 'screenshot_token',
      outcome: 'issued',
      ip: '203.0.113.42',
      userAgent: 'screenshot-tool/2.0',
      userId: SCREENSHOT_USER.id,
      expiresIn: 900,
    });
    // tokenHash — sha256-hex (64 hex chars)
    expect(typeof parsed.tokenHash).toBe('string');
    expect(parsed.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    // raw token never appears in log
    expect(message).not.toContain('signed.jwt.value');

    // Prometheus inc — с тем же ip
    expect(metrics.incScreenshotTokenIssued).toHaveBeenCalledTimes(1);
    expect(metrics.incScreenshotTokenIssued).toHaveBeenCalledWith(
      '203.0.113.42',
    );

    logSpy.mockRestore();
  });

  it('KS-2305: на no_account — structured JSON-warn-log, метрика НЕ инкрементируется', async () => {
    const prisma = makePrisma(null);
    const jwt = makeJwt('jwt');
    const metrics = {
      incScreenshotTokenIssued: jest.fn(),
    } as unknown as MetricsService;
    const ctrl = new ScreenshotTokenController(
      prisma,
      jwt,
      makeConfig('15m'),
      metrics,
    );
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const req = {
      headers: { 'user-agent': 'screenshot-tool/2.0' },
      ip: '10.0.0.42',
    } as unknown as Request;

    await expect(ctrl.issueScreenshotToken(req)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      event: 'screenshot_token',
      outcome: 'no_account',
      ip: '10.0.0.42',
      userAgent: 'screenshot-tool/2.0',
      username: '__screenshot_agent',
    });

    expect(metrics.incScreenshotTokenIssued).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('KS-2305: MetricsService через @Optional — отсутствие сервиса не ломает endpoint', async () => {
    const prisma = makePrisma(SCREENSHOT_USER);
    const jwt = makeJwt('jwt');
    // metrics не передан (Prometheus не подключён в этом миниприложении)
    const ctrl = new ScreenshotTokenController(prisma, jwt, makeConfig('15m'));

    const result = await ctrl.issueScreenshotToken(makeReq());
    expect(result.accessToken).toBe('jwt');
    // Никакого throw'а на отсутствие metrics; контракт выдачи сохраняется.
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
  metrics?: MetricsService;
}): Promise<INestApplication> {
  const providers: Array<unknown> = [
    { provide: PrismaService, useValue: opts.prisma },
    { provide: RealJwtService, useValue: opts.jwt },
    { provide: RealConfigService, useValue: opts.config },
    { provide: RedisService, useValue: opts.redis },
    Reflector,
    RedisRateLimitGuard,
    ScreenshotTokenRateLimitGuard,
  ];
  if (opts.metrics) {
    providers.push({ provide: MetricsService, useValue: opts.metrics });
  }
  const moduleRef = await Test.createTestingModule({
    controllers: [ScreenshotTokenController],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    providers: providers as any,
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

  it('11-й запрос с того же IP в окне → 429 + structured-log outcome=rate_limited', async () => {
    const prisma = makePrisma(SCREENSHOT_USER);
    const jwt = makeJwt('signed.jwt.value');
    const config = makeConfig('15m');
    const redis = makeFakeRedis();

    app = await buildApp({ prisma, jwt, config, redis });

    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    // 10 запросов подряд — должны проходить (200/201).
    for (let i = 1; i <= 10; i++) {
      await request(app.getHttpServer())
        .post('/internal/screenshot-token')
        .set('X-Forwarded-For', '203.0.113.99')
        .expect((res) => {
          if (res.status >= 400) {
            throw new Error(`request #${i} failed: ${res.status}`);
          }
        });
    }
    // 11-й — превысил лимит, 429.
    await request(app.getHttpServer())
      .post('/internal/screenshot-token')
      .set('X-Forwarded-For', '203.0.113.99')
      .expect(429);

    // EXPIRE поставлен ровно один раз (на 1-м запросе в окне).
    expect(redis.expire).toHaveBeenCalledTimes(1);

    // KS-2305: rate-limit guard оставил structured-log с outcome=rate_limited.
    const rateLimitedCalls = warnSpy.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => typeof m === 'string' && m.includes('"rate_limited"'));
    expect(rateLimitedCalls.length).toBeGreaterThanOrEqual(1);
    const rl = JSON.parse(rateLimitedCalls[0]);
    expect(rl).toMatchObject({
      event: 'screenshot_token',
      outcome: 'rate_limited',
      ip: '203.0.113.99',
    });

    warnSpy.mockRestore();
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
