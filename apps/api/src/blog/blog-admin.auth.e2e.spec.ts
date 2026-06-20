/**
 * KS-4457 / ADR-139 T5. Интеграционный тест авторизации BlogAdminController.
 *
 * Поднимает реальный NestJS bootstrap с импортом продакшен `AuthModule`
 * (а не списком провайдеров inline). Это критично: предыдущая редакция
 * теста перечисляла гарды в `providers: [...]`, из-за чего DI всегда
 * собирался — даже когда `AuthModule.exports` забывал экспортировать
 * `JwtAuthGuard`. Регрессия 31d3a7e4 (крэш-луп kingside-api task-def 573)
 * прошла мимо. Теперь тест компилирует тот же граф зависимостей, что и
 * прод: BlogAdminController → AuthModule (export JwtAuthGuard +
 * AdminOrServiceGuard + ...) — и упадёт на `compile()`, если контракт
 * `AuthModule.exports` снова сломают.
 *
 * Все 6 GWT-сценариев из задачи KS-4457:
 *
 *   1. human-admin с валидным JWT (whitelist KS_ADMIN_USERS)         → 200
 *   2. не-admin JWT (юзер вне whitelist)                              → 403
 *   3. без Authorization-заголовка                                    → 401
 *   4. service-account `ks_sa_*` со scope `blog:write`                → 200
 *   5. service-account без scope `blog:write` (только `lessons:read`) → 403
 *   6. revoked service-account (revokedAt в прошлом)                  → 401
 *
 * Инфра-провайдеры (`PrismaService`, `RedisService`, `I18nService`) и
 * доменные сервисы блога подменены mock'ами через `.overrideProvider()`
 * — реальная БД/Redis не поднимается.
 */
import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import {
  Global,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { I18nService } from 'nestjs-i18n';
import request from 'supertest';
import type { Server } from 'http';
import { createHash } from 'node:crypto';
import { BlogAdminController } from './blog-admin.controller';
import { BlogAdminService } from './blog-admin.service';
import { BlogMediaService } from './blog-media.service';
import { AuthModule } from '../auth/auth.module';
import { SERVICE_ACCOUNT_PREFIX } from '../auth/service-account.guard';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

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

const adminDelete = jest.fn().mockResolvedValue(undefined);
const userFindUnique = jest.fn();
const agentFindFirst = jest.fn();
const agentUpdate = jest.fn().mockResolvedValue({});

/** @Global-модуль с заглушками для инфра-провайдеров, которые в проде
 *  поднимаются глобальными модулями (`RedisModule` имеет `@Global()`,
 *  `I18nModule` живёт в `AppModule`). В тесте мы AppModule не поднимаем,
 *  поэтому глобально подсовываем mock'и под теми же токенами, чтобы
 *  AuthService (нужен I18nService) и ScreenshotTokenRateLimitGuard
 *  (нужен RedisService) разрешили зависимости при инстанцировании. */
@Global()
@Module({
  providers: [
    { provide: RedisService, useValue: {} },
    {
      provide: I18nService,
      useValue: { t: jest.fn().mockReturnValue('mock') },
    },
  ],
  exports: [RedisService, I18nService],
})
class TestGlobalInfraModule {}

/** Модуль-обёртка повторяет прод-сценарий: контроллер блога живёт в
 *  своём модуле, который импортирует `AuthModule`. Если экспорт
 *  `AuthModule.exports` неполный, `compile()` упадёт — это и есть
 *  e2e-проверка DI-контракта. */
@Module({
  imports: [AuthModule],
  controllers: [BlogAdminController],
  providers: [
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
  ],
})
class TestBlogConsumerModule {}

describe('BlogAdminController · AdminOrServiceGuard (KS-4457 / ADR-139 T5)', () => {
  let app: INestApplication;
  let jwtService: JwtService;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.JWT_EXPIRES_IN = '15m';
    process.env.KS_ADMIN_USERS = ADMIN_USERNAME;

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TestGlobalInfraModule,
        TestBlogConsumerModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({
        user: { findUnique: userFindUnique },
        agentServiceAccount: {
          findFirst: agentFindFirst,
          update: agentUpdate,
        },
      })
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
    jwtService = module.get(JwtService);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    adminDelete.mockClear();
    userFindUnique.mockReset();
    agentFindFirst.mockReset();
    agentUpdate.mockClear();

    // service-account lookup — фильтр совпадает с продакшн-логикой
    // (`where: { tokenHash, revokedAt: null }`).
    agentFindFirst.mockImplementation(
      async (args: { where: { tokenHash: string; revokedAt: null } }) => {
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
        // SA_REVOKED_TOKEN: revokedAt IS NOT NULL → запись отфильтрована.
        return null;
      },
    );
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
    expect(userFindUnique).not.toHaveBeenCalled();
  });
});
