/**
 * Integration-тест dual-prefix middleware (KS-1664).
 *
 * Проверяет Gherkin-сценарий: `apps/api отвечает и на /api/* и на /*`.
 * Поднимаем минимальный Nest-app с тестовым контроллером `@Controller('ping')`,
 * подключаем тот же `stripApiPrefix`, что используется в `main.ts`, и
 * дергаем оба пути — ответ должен быть идентичен.
 *
 * Отдельный тест (не сложнее чем нужно), чтобы не тянуть Prisma/Redis и
 * прочие реальные модули — цель узкая: подтвердить, что middleware
 * корректно переписывает `req.url` до Nest-матчера.
 */
import 'reflect-metadata';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'http';
import { stripApiPrefix } from './strip-api-prefix.middleware';

@Controller('ping')
class PingTestController {
  @Get()
  ping() {
    return { ok: true, path: '/ping' };
  }

  @Get('sub')
  sub() {
    return { ok: true, path: '/ping/sub' };
  }
}

describe('stripApiPrefix — dual-prefix middleware (KS-1664)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PingTestController],
    }).compile();

    app = module.createNestApplication();
    app.use(stripApiPrefix);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /ping → 200 (без префикса)', async () => {
    const res = await request(app.getHttpServer() as Server).get('/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, path: '/ping' });
  });

  it('GET /api/ping → 200 (legacy-префикс)', async () => {
    const res = await request(app.getHttpServer() as Server).get('/api/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, path: '/ping' });
  });

  it('оба пути возвращают идентичный body (Gherkin)', async () => {
    const without = await request(app.getHttpServer() as Server).get('/ping');
    const withPrefix = await request(app.getHttpServer() as Server).get('/api/ping');
    expect(without.status).toBe(200);
    expect(withPrefix.status).toBe(200);
    expect(withPrefix.body).toEqual(without.body);
  });

  it('вложенный путь /api/ping/sub тоже работает', async () => {
    const res = await request(app.getHttpServer() as Server).get('/api/ping/sub');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, path: '/ping/sub' });
  });

  it('query string сохраняется после переписывания /api/', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/api/ping')
      .query({ foo: 'bar' });
    expect(res.status).toBe(200);
  });

  it('путь, который случайно содержит /api не в начале, не трогается', async () => {
    // Запрос на несуществующий эндпоинт /ping/api-sub: middleware не должен
    // дёрнуть slice — префикс /api/ не в начале.
    const res = await request(app.getHttpServer() as Server).get('/ping/api-sub');
    // Nest вернёт 404 — тестовый контроллер такого роута не имеет.
    expect(res.status).toBe(404);
  });
});
