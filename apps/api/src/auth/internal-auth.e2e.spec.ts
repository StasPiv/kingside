/**
 * KS-2182. E2E-тест: полный flow `synthetic-token → JwtAuthGuard
 * валидирует токен`. Закрывает Av3 (последний пункт в задаче — «выданный
 * JWT валиден стандартным `JwtAuthGuard`»).
 *
 * Что проверяется:
 *   1. POST `/internal/auth/synthetic-token` с правильным заголовком и
 *      synthetic-user.id → 201 и валидный JWT.
 *   2. Этот же JWT передаётся в обычный `JwtAuthGuard` (через тестовый
 *      controller `/__test/echo-user`) и пропускается, payload `{sub,
 *      username}` корректен.
 *   3. POST без `X-Internal-Auth` → 401 (guard, GWT-сценарий 6).
 *   4. POST с правильным заголовком и non-synthetic user → 403
 *      (GWT-сценарий 2).
 *
 * `PrismaService` мокаем — отдельная in-memory ставка вокруг user-таблицы.
 * Мы НЕ поднимаем БД для e2e: цель теста — JWT-flow, а не интеграция
 * c Postgres (она уже покрыта unit'ами `prisma.user.findUnique` mock'а).
 */
import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import {
  Controller,
  Get,
  INestApplication,
  Request as Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request from 'supertest';
import type { Server } from 'http';
import { InternalAuthController } from './internal-auth.controller';
import { InternalKeyGuard } from './internal-key.guard';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedRequest } from '../common/authenticated-request';

const SYNTH = {
  id: '00000000-0000-4000-b000-000000000001',
  username: 'bot-001',
  isSynthetic: true,
};
const HUMAN = {
  id: '11111111-1111-4111-a111-111111111111',
  username: 'john',
  isSynthetic: false,
};
const NEW_KEY = 'test-internal-key-secret123';

@Controller('__test')
class EchoUserController {
  @UseGuards(JwtAuthGuard)
  @Get('echo-user')
  echo(@Req() req: AuthenticatedRequest) {
    return { id: req.user.id, username: req.user.username };
  }
}

describe('InternalAuth E2E — KS-2182', () => {
  let app: INestApplication;
  const findUnique = jest.fn();

  beforeAll(async () => {
    process.env.SYNTHETIC_BOT_INTERNAL_KEY = NEW_KEY;
    process.env.JWT_SECRET = 'e2e-test-jwt-secret';
    process.env.JWT_EXPIRES_IN = '15m';

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PassportModule,
        JwtModule.register({
          secret: 'e2e-test-jwt-secret',
          signOptions: { expiresIn: '15m' },
        }),
      ],
      controllers: [InternalAuthController, EchoUserController],
      providers: [
        InternalKeyGuard,
        JwtStrategy,
        {
          provide: PrismaService,
          useValue: { user: { findUnique } },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    findUnique.mockReset();
  });

  it('GWT-сценарий 1 + JWT-валидация: synthetic → JwtAuthGuard пропускает выданный токен', async () => {
    findUnique.mockResolvedValueOnce(SYNTH);

    const tokenRes = await request(app.getHttpServer() as Server)
      .post('/internal/auth/synthetic-token')
      .set('X-Internal-Auth', NEW_KEY)
      .send({ botUserId: SYNTH.id });

    expect(tokenRes.status).toBe(201);
    expect(tokenRes.body.expiresIn).toBe(900);
    expect(typeof tokenRes.body.accessToken).toBe('string');

    // Проверяем, что выданный токен пропускается стандартным
    // JwtAuthGuard'ом (без bot-only флагов в payload — обычный JWT).
    const echoRes = await request(app.getHttpServer() as Server)
      .get('/__test/echo-user')
      .set('Authorization', `Bearer ${tokenRes.body.accessToken}`);

    expect(echoRes.status).toBe(200);
    expect(echoRes.body).toEqual({
      id: SYNTH.id,
      username: SYNTH.username,
    });
  });

  it('GWT-сценарий 2: non-synthetic user → 403, токен не выдан', async () => {
    findUnique.mockResolvedValueOnce(HUMAN);

    const res = await request(app.getHttpServer() as Server)
      .post('/internal/auth/synthetic-token')
      .set('X-Internal-Auth', NEW_KEY)
      .send({ botUserId: HUMAN.id });

    expect(res.status).toBe(403);
    expect(res.body.accessToken).toBeUndefined();
  });

  it('GWT-сценарий 6: запрос без X-Internal-Auth → 401', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/internal/auth/synthetic-token')
      .send({ botUserId: SYNTH.id });

    expect(res.status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('GWT-сценарий 6 (вариант): неверный X-Internal-Auth → 403', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/internal/auth/synthetic-token')
      .set('X-Internal-Auth', 'wrong-key-of-same-length-as-config')
      .send({ botUserId: SYNTH.id });

    expect(res.status).toBe(403);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
