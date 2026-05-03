/**
 * KS-2306 (ADR-039 §4, SCR2 E1) — E2E `POST /internal/screenshot-token`.
 *
 * Покрывает acceptance:
 *  1. После seed'а `__screenshot_agent` (KS-2257) endpoint отдаёт
 *     201 + JWT, payload `{sub: user.id, username: '__screenshot_agent'}`,
 *     `expiresIn` — положительное число секунд.
 *  2. Без аккаунта (`isHidden=true` запись удалена) — 503.
 *  3. 11 подряд запросов с одного IP → 11-й 429 (`RedisRateLimitGuard`
 *     `@RateLimit(10, 60)`).
 *
 * Окружение: PostgreSQL + Redis из `apps/api/.env`. Если Redis недоступен,
 * rate-limit-сценарий помечается `it.skip` (guard fail-open пропускает,
 * 11-й запрос вернёт 201 — это не баг, а вырожденный дев-режим).
 *
 * Изоляция rate-limit:
 *  - Ключ guard'а — `ratelimit:<ip>:POST:/internal/screenshot-token`.
 *  - Каждый тест посылает уникальный `X-Forwarded-For`, поэтому окна
 *    у тестов не пересекаются. Никаких ручных `redis.del(...)`.
 */
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';
import { SCREENSHOT_AGENT_USERNAME } from '../src/scripts/seed-screenshot-account';

jest.setTimeout(30_000);

describe('POST /internal/screenshot-token e2e (KS-2306)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let redisAvailable = false;

  // userId засеянного аккаунта — для проверки `sub` в JWT-payload.
  // Re-seed'им в каждом блоке, который требует наличия аккаунта.
  let seededUserId: string | null = null;

  async function deleteAgentIfExists(): Promise<void> {
    const existing = await prisma.user.findUnique({
      where: { username: SCREENSHOT_AGENT_USERNAME },
      select: { id: true },
    });
    if (existing) {
      await prisma.user.delete({ where: { id: existing.id } });
    }
  }

  async function seedAgent(): Promise<string> {
    const passwordHash = await bcrypt.hash('e2e-screenshot-pwd', 10);
    const user = await prisma.user.upsert({
      where: { username: SCREENSHOT_AGENT_USERNAME },
      update: {
        passwordHash,
        isTestAccount: true,
        isHidden: true,
      },
      create: {
        username: SCREENSHOT_AGENT_USERNAME,
        email: `${SCREENSHOT_AGENT_USERNAME}@kingside.local`,
        passwordHash,
        isTestAccount: true,
        isHidden: true,
        requiresUsernameSetup: false,
      },
      select: { id: true },
    });
    return user.id;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    // ioredis подключается лениво. Делаем ping с явным таймаутом 2с —
    // если PONG получен, Redis рабочий; иначе считаем недоступным и
    // соответствующие тесты помечаем skip.
    redisAvailable = await Promise.race([
      redis
        .ping()
        .then((pong) => pong === 'PONG')
        .catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
  });

  afterAll(async () => {
    await deleteAgentIfExists().catch(() => {});
    if (app) await app.close();
  });

  it('GWT-1: аккаунт засеен → 201 + JWT с sub=user.id, username=__screenshot_agent', async () => {
    seededUserId = await seedAgent();

    const res = await request(app.getHttpServer())
      .post('/internal/screenshot-token')
      .set('X-Forwarded-For', '203.0.113.10')
      .expect(201);

    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.accessToken).toMatch(
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
    expect(typeof res.body.expiresIn).toBe('number');
    expect(res.body.expiresIn).toBeGreaterThan(0);

    // Декод JWT-payload (не верифицируем подпись — тестируем контракт).
    const [, payloadB64] = (res.body.accessToken as string).split('.');
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    );
    expect(payload.sub).toBe(seededUserId);
    expect(payload.username).toBe(SCREENSHOT_AGENT_USERNAME);
  });

  it('GWT-2: аккаунта нет → 503 ServiceUnavailable, токен не выдаётся', async () => {
    await deleteAgentIfExists();

    const res = await request(app.getHttpServer())
      .post('/internal/screenshot-token')
      .set('X-Forwarded-For', '203.0.113.20')
      .expect(503);

    expect(res.body.message).toMatch(/screenshot account is not provisioned/i);
    expect(res.body.accessToken).toBeUndefined();
  });

  // GWT-3: rate-limit. Без Redis guard fail-open всегда даёт 201, тогда
  // тест бессмыслен — выходим раньше с warning. Тернарник на уровне
  // describe не работает (Jest строит test-tree до `beforeAll`, поэтому
  // `redisAvailable` ещё false), отсюда — `if (!redisAvailable) return`.
  it('GWT-3: 10 успешных запросов с одного IP, 11-й → 429', async () => {
    if (!redisAvailable) {
      // eslint-disable-next-line no-console
      console.warn('e2e: skipped GWT-3 — Redis unavailable');
      return;
    }
    seededUserId = await seedAgent();

    const xff = '203.0.113.30';
    // На случай прошлого прогона — сбросим счётчик для этого IP.
    const route = 'POST:/internal/screenshot-token';
    await redis.del(`ratelimit:${xff}:${route}`).catch(() => {});

    for (let i = 1; i <= 10; i++) {
      const r = await request(app.getHttpServer())
        .post('/internal/screenshot-token')
        .set('X-Forwarded-For', xff);
      if (r.status >= 400) {
        throw new Error(`request #${i} failed with status ${r.status}`);
      }
    }

    const eleventh = await request(app.getHttpServer())
      .post('/internal/screenshot-token')
      .set('X-Forwarded-For', xff);
    expect(eleventh.status).toBe(429);
  });

  // Use redis to suppress unused warning if redisAvailable=false short-circuits
  void redis;
});
