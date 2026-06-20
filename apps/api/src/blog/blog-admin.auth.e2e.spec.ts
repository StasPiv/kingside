/**
 * KS-4457 / ADR-139 T5. Интеграционный тест авторизации BlogAdminController.
 *
 * Проверяет реальную сборку `AdminOrServiceGuard` (JwtAuthGuard +
 * AdminUserGuard ИЛИ ServiceAccountGuard + scope) на mutating-эндпоинте
 * `DELETE /admin/blog/posts/:id`. Все 6 GWT-сценариев из задачи:
 *
 *   1. human-admin с валидным JWT (whitelist KS_ADMIN_USERS)         → 200
 *   2. не-admin JWT (юзер вне whitelist)                              → 403
 *   3. без Authorization-заголовка                                    → 401
 *   4. service-account `ks_sa_*` со scope `blog:write`                → 200
 *   5. service-account без scope `blog:write` (только `lessons:read`) → 403
 *   6. revoked service-account (revokedAt в прошлом)                  → 401
 *
 * `BlogAdminService` и `BlogMediaService` подменены mock'ами — тест
 * проверяет авторизационную поверхность, не доменную логику. `PrismaService`
 * тоже mock: для admin-цепочки нужен `user.findUnique`, для service-account
 * — `agentServiceAccount.findFirst`. Реальная БД не поднимается.
 */
import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import type { Server } from 'http';
import { createHash } from 'node:crypto';
import { BlogAdminController } from './blog-admin.controller';
import { BlogAdminService } from './blog-admin.service';
import { BlogMediaService } from './blog-media.service';
import { JwtStrategy } from '../auth/jwt.strategy';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminUserGuard } from '../auth/admin-user.guard';
import { ServiceAccountGuard, SERVICE_ACCOUNT_PREFIX } from '../auth/service-account.guard';
import { AdminOrServiceGuard } from '../auth/admin-or-service.guard';
import { PrismaService } from '../prisma/prisma.service';

const JWT_SECRET = 'e2e-blog-admin-secret';
const ADMIN_USERNAME = 'admin-alice';
const NON_ADMIN_USERNAME = 'plain-bob';
const ADMIN_USER_ID = '11111111-1111-4111-a111-111111111111';
const NON_ADMIN_USER_ID = '22222222-2222-4222-a222-222222222222';
const POST_ID = '33333333-3333-4333-a333-333333333333';

const SA_VALID_TOKEN = `${SERVICE_ACCOUNT_PREFIX}valid_writer_token_xxxxxxxxxxxxx`;
const SA_NO_SCOPE_TOKEN = `${SERVICE_ACCOUNT_PREFIX}readonly_lessons_token_xxxxxx`;
const SA_REVOKED_TOKEN = `${SERVICE_ACCOUNT_PREFIX}revoked_writer_token_xxxxxxxxxx`;

function sha256(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

describe('BlogAdminController · AdminOrServiceGuard (KS-4457 / ADR-139 T5)', () => {
  let app: INestApplication;
  let jwtService: JwtService;

  const adminDelete = jest.fn().mockResolvedValue(undefined);
  const userFindUnique = jest.fn();
  const agentFindFirst = jest.fn();
  const agentUpdate = jest.fn().mockResolvedValue({});

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.JWT_EXPIRES_IN = '15m';
    process.env.KS_ADMIN_USERS = ADMIN_USERNAME;

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PassportModule,
        JwtModule.registerAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            secret: config.get<string>('JWT_SECRET'),
            signOptions: { expiresIn: config.get('JWT_EXPIRES_IN', '15m') },
          }),
        }),
      ],
      controllers: [BlogAdminController],
      providers: [
        Reflector,
        JwtStrategy,
        JwtAuthGuard,
        AdminUserGuard,
        ServiceAccountGuard,
        AdminOrServiceGuard,
        {
          provide: BlogAdminService,
          useValue: {
            listPosts: jest.fn(),
            getPost: jest.fn(),
            createPost: jest.fn(),
            updatePost: jest.fn(),
            deletePost: adminDelete,
            setStatus: jest.fn(),
            previewMarkdown: jest.fn(),
            listAuthors: jest.fn(),
            getAuthor: jest.fn(),
            createAuthor: jest.fn(),
            updateAuthor: jest.fn(),
            deleteAuthor: jest.fn(),
          },
        },
        {
          provide: BlogMediaService,
          useValue: {
            isConfigured: jest.fn().mockReturnValue(false),
            uploadCover: jest.fn(),
            getAllowedMimeTypes: jest
              .fn()
              .mockReturnValue(['image/png', 'image/jpeg', 'image/webp']),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            user: { findUnique: userFindUnique },
            agentServiceAccount: {
              findFirst: agentFindFirst,
              update: agentUpdate,
            },
          },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
    jwtService = module.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    adminDelete.mockClear();
    userFindUnique.mockReset();
    agentFindFirst.mockReset();
    agentUpdate.mockClear();

    // service-account lookup — реализация по tokenHash и revokedAt:null,
    // совпадает с продакшн-фильтром `where: { tokenHash, revokedAt: null }`.
    agentFindFirst.mockImplementation(async (args: { where: { tokenHash: string; revokedAt: null } }) => {
      if (args.where.tokenHash === sha256(SA_VALID_TOKEN)) {
        return {
          id: 'sa-1',
          handle: 'agent-blog-writer',
          scopes: ['blog:write', 'blog:read'],
        };
      }
      if (args.where.tokenHash === sha256(SA_NO_SCOPE_TOKEN)) {
        return {
          id: 'sa-2',
          handle: 'agent-lessons-reader',
          scopes: ['lessons:read'],
        };
      }
      // SA_REVOKED_TOKEN: revokedAt IS NOT NULL → findFirst с
      // фильтром `revokedAt: null` отдаёт null.
      return null;
    });
  });

  function signJwt(sub: string, username: string): string {
    return jwtService.sign({ sub, username });
  }

  // ── Сценарий 1: human-admin с валидным JWT → 200 ─────────────────
  it('1) human-admin с валидным JWT → 200 на DELETE /admin/blog/posts/:id', async () => {
    userFindUnique.mockResolvedValueOnce({ username: ADMIN_USERNAME });
    const token = signJwt(ADMIN_USER_ID, ADMIN_USERNAME);

    const res = await request(app.getHttpServer() as Server)
      .delete(`/admin/blog/posts/${POST_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(adminDelete).toHaveBeenCalledWith(POST_ID);
    // service-account-цепочка не должна была сработать на JWT-токене.
    expect(agentFindFirst).not.toHaveBeenCalled();
  });

  // ── Сценарий 2: не-admin JWT → 403 ───────────────────────────────
  it('2) не-admin JWT (username вне KS_ADMIN_USERS) → 403', async () => {
    userFindUnique.mockResolvedValueOnce({ username: NON_ADMIN_USERNAME });
    const token = signJwt(NON_ADMIN_USER_ID, NON_ADMIN_USERNAME);

    const res = await request(app.getHttpServer() as Server)
      .delete(`/admin/blog/posts/${POST_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(adminDelete).not.toHaveBeenCalled();
  });

  // ── Сценарий 3: без токена → 401 ─────────────────────────────────
  it('3) без Authorization → 401', async () => {
    const res = await request(app.getHttpServer() as Server).delete(
      `/admin/blog/posts/${POST_ID}`,
    );

    expect(res.status).toBe(401);
    expect(adminDelete).not.toHaveBeenCalled();
    // Ни одна из веток гарда не должна была лезть в БД за конкретной записью:
    // префикса ks_sa_ нет → service-account fall-through; JWT отсутствует → 401.
    expect(agentFindFirst).not.toHaveBeenCalled();
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  // ── Сценарий 4: service-account со scope blog:write → 200 ────────
  it('4) service-account ks_sa_* со scope blog:write → 200', async () => {
    const res = await request(app.getHttpServer() as Server)
      .delete(`/admin/blog/posts/${POST_ID}`)
      .set('Authorization', `Bearer ${SA_VALID_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(adminDelete).toHaveBeenCalledWith(POST_ID);
    // JWT-цепочка не должна была включиться — токен распознан как
    // service-account по префиксу ks_sa_.
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  // ── Сценарий 5: service-account без scope blog:write → 403 ───────
  it('5) service-account без scope blog:write (только lessons:read) → 403', async () => {
    const res = await request(app.getHttpServer() as Server)
      .delete(`/admin/blog/posts/${POST_ID}`)
      .set('Authorization', `Bearer ${SA_NO_SCOPE_TOKEN}`);

    expect(res.status).toBe(403);
    expect(adminDelete).not.toHaveBeenCalled();
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  // ── Сценарий 6: revoked service-account → 401 ────────────────────
  it('6) revoked service-account → 401 (запись отсутствует по фильтру revokedAt:null)', async () => {
    const res = await request(app.getHttpServer() as Server)
      .delete(`/admin/blog/posts/${POST_ID}`)
      .set('Authorization', `Bearer ${SA_REVOKED_TOKEN}`);

    expect(res.status).toBe(401);
    expect(adminDelete).not.toHaveBeenCalled();
    // Префикс ks_sa_ был → service-account-ветка отработала и бросила
    // 401, fall-through в JWT-цепочку запрещён.
    expect(userFindUnique).not.toHaveBeenCalled();
  });
});
