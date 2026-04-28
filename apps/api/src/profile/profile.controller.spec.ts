/**
 * KS-2108 — `GET /api/profile/me/admin-status` отдаёт `{ isAdmin }`
 * для аутентифицированного пользователя.
 */
import { Test } from '@nestjs/testing';
import { CanActivate, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ProfileController } from './profile.controller';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminUserService } from '../auth/admin-user.guard';

class AllowGuard implements CanActivate {
  constructor(private readonly userId: string | null) {}
  canActivate(ctx: import('@nestjs/common').ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (this.userId) req.user = { id: this.userId };
    return true;
  }
}
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

async function makeApp(opts: {
  auth: boolean;
  userId?: string;
  isAdmin: boolean;
}): Promise<INestApplication> {
  const adminService = {
    isAdmin: jest.fn(async () => opts.isAdmin),
  } as unknown as AdminUserService;
  const mod = await Test.createTestingModule({
    controllers: [ProfileController],
    providers: [{ provide: AdminUserService, useValue: adminService }],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue(opts.auth ? new AllowGuard(opts.userId ?? 'u1') : new DenyGuard())
    .compile();
  const app = mod.createNestApplication();
  await app.init();
  return app;
}

describe('ProfileController.adminStatus — KS-2108', () => {
  let app: INestApplication;
  afterEach(async () => {
    if (app) await app.close();
  });

  it('возвращает { isAdmin: true } для админа', async () => {
    app = await makeApp({ auth: true, isAdmin: true });
    const res = await request(app.getHttpServer())
      .get('/profile/me/admin-status')
      .expect(200);
    expect(res.body).toEqual({ isAdmin: true });
  });

  it('возвращает { isAdmin: false } для не-админа', async () => {
    app = await makeApp({ auth: true, isAdmin: false });
    const res = await request(app.getHttpServer())
      .get('/profile/me/admin-status')
      .expect(200);
    expect(res.body).toEqual({ isAdmin: false });
  });

  it('без auth → 403 (overrideGuard)', async () => {
    app = await makeApp({ auth: false, isAdmin: true });
    await request(app.getHttpServer())
      .get('/profile/me/admin-status')
      .expect(403);
  });
});
