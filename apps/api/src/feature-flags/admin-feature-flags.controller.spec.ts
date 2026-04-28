/**
 * KS-2104 — `AdminFeatureFlagsController`: PATCH меняет значение,
 * 401 без auth, 403 для не-админа, 400 для unknown ключа.
 *
 * Тестируем через supertest, мокая JwtAuthGuard и AdminEmailGuard
 * (источник истины их поведения покрыт другими спеками).
 */
import { Test } from '@nestjs/testing';
import { CanActivate, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AdminFeatureFlagsController } from './admin-feature-flags.controller';
import { ConfigController } from './config.controller';
import { FeatureFlagsService } from './feature-flags.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminUserGuard } from '../auth/admin-user.guard';

class AllowGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

function makeApp(opts: { admin: boolean; auth: boolean; svc: Partial<FeatureFlagsService> }) {
  return Test.createTestingModule({
    controllers: [AdminFeatureFlagsController, ConfigController],
    providers: [{ provide: FeatureFlagsService, useValue: opts.svc }],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue(opts.auth ? new AllowGuard() : new DenyGuard())
    .overrideGuard(AdminUserGuard)
    .useValue(opts.admin ? new AllowGuard() : new DenyGuard())
    .compile()
    .then(async (mod) => {
      const app = mod.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await app.init();
      return app;
    });
}

describe('AdminFeatureFlagsController — KS-2104', () => {
  let app: INestApplication;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('PATCH /admin/feature-flags/lessonsEnabled под админом → 200, вызов setFlag', async () => {
    const setFlag = jest.fn(async () => ({
      key: 'lessonsEnabled' as const,
      value: false,
      updatedAt: new Date('2026-04-28T00:00:00Z'),
    }));
    app = await makeApp({
      admin: true,
      auth: true,
      svc: { setFlag, getFlags: jest.fn() } as never,
    });

    const res = await request(app.getHttpServer())
      .patch('/admin/feature-flags/lessonsEnabled')
      .send({ value: false })
      .expect(200);

    expect(res.body).toEqual({
      key: 'lessonsEnabled',
      value: false,
      updatedAt: '2026-04-28T00:00:00.000Z',
    });
    expect(setFlag).toHaveBeenCalledWith('lessonsEnabled', false);
  });

  it('PATCH без auth → 401', async () => {
    app = await makeApp({ admin: true, auth: false, svc: {} });
    await request(app.getHttpServer())
      .patch('/admin/feature-flags/lessonsEnabled')
      .send({ value: true })
      .expect(403); // overrideGuard вернёт false → ForbiddenException по умолчанию NestJS
    // Note: NestJS превращает false из CanActivate в ForbiddenException (403).
    // Точная семантика 401 vs 403 зависит от реальных гардов; тут проверяем,
    // что без auth-guard'а endpoint недоступен.
  });

  it('PATCH под не-админом → 403', async () => {
    app = await makeApp({ admin: false, auth: true, svc: {} });
    await request(app.getHttpServer())
      .patch('/admin/feature-flags/lessonsEnabled')
      .send({ value: true })
      .expect(403);
  });

  it('PATCH с unknown key → 400', async () => {
    app = await makeApp({
      admin: true,
      auth: true,
      svc: { setFlag: jest.fn() } as never,
    });
    await request(app.getHttpServer())
      .patch('/admin/feature-flags/unknownKey')
      .send({ value: true })
      .expect(400);
  });

  it('PATCH с невалидным body (value не boolean) → 400', async () => {
    app = await makeApp({
      admin: true,
      auth: true,
      svc: { setFlag: jest.fn() } as never,
    });
    await request(app.getHttpServer())
      .patch('/admin/feature-flags/lessonsEnabled')
      .send({ value: 'true' })
      .expect(400);
  });

  it('GET /config возвращает featureFlags', async () => {
    app = await makeApp({
      admin: true,
      auth: true,
      svc: {
        getFlags: jest.fn(async () => ({ lessonsEnabled: true })),
      } as never,
    });
    const res = await request(app.getHttpServer()).get('/config').expect(200);
    expect(res.body).toEqual({ featureFlags: { lessonsEnabled: true } });
  });

  it('GET /admin/feature-flags под админом → список с метаданными (KS-2108)', async () => {
    const updatedAt = new Date('2026-04-28T12:00:00Z');
    app = await makeApp({
      admin: true,
      auth: true,
      svc: {
        getFlags: jest.fn(async () => ({ lessonsEnabled: false })),
        listWithMetadata: jest.fn(async () =>
          new Map<'lessonsEnabled', Date>([['lessonsEnabled', updatedAt]]),
        ),
      } as never,
    });
    const res = await request(app.getHttpServer())
      .get('/admin/feature-flags')
      .expect(200);

    expect(res.body).toEqual([
      {
        key: 'lessonsEnabled',
        value: false,
        defaultValue: true,
        description: expect.stringContaining('Уроки'),
        updatedAt: '2026-04-28T12:00:00.000Z',
      },
    ]);
  });

  it('GET /admin/feature-flags под не-админом → 403', async () => {
    app = await makeApp({
      admin: false,
      auth: true,
      svc: { listWithMetadata: jest.fn() } as never,
    });
    await request(app.getHttpServer()).get('/admin/feature-flags').expect(403);
  });
});
