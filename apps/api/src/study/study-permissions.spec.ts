/**
 * KS-2815 / KS-2822 T7. Permissions matrix для всех эндпоинтов
 * StudyController × роли (anonymous / owner / другой user).
 *
 * Admin для Studies в MVP не отличается от обычного пользователя —
 * никаких супер-прав на чужие приватные ресурсы нет (см. §B.1 KS-2815:
 * «только owner, без contributor / viewer»). Соответствующие колонки
 * матрицы покрываются «другим пользователем», который ведёт себя
 * идентично admin'у.
 *
 * Покрытие гоняем через `StudyController` + overrideGuard. Guards
 * сами не покрываются здесь — у них отдельные unit-тесты по
 * `study-access.guard.ts` / `study-owner.guard.ts`; здесь убеждаемся,
 * что контроллер корректно отвечает в каждой ячейке матрицы.
 */
import { Test } from '@nestjs/testing';
import {
  CanActivate,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { StudyController } from './study.controller';
import { StudyService } from './study.service';
import { StudyChaptersService } from './study-chapters.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  StudyAccessGuard,
  StudyResource,
} from './study-access.guard';
import { StudyOwnerGuard } from './study-owner.guard';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';

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
class AttachUserGuard implements CanActivate {
  constructor(private readonly userId: string | null) {}
  canActivate(ctx: any): boolean {
    const req = ctx.switchToHttp().getRequest();
    req.user = this.userId ? { id: this.userId, username: 'u' } : undefined;
    return true;
  }
}

type Role = 'anonymous' | 'owner' | 'other';

const owner = 'owner-uuid';
const other = 'other-uuid';
const slug = 'abc-study';
const chapterId = 'chapter-1';

const ownerStudy = {
  id: 'study-1',
  ownerId: owner,
  slug,
  name: 'Mine',
  description: null,
  isPublic: false,
  chaptersCount: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

async function appFor(role: Role, isPublic: boolean): Promise<INestApplication> {
  const userId = role === 'owner' ? owner : role === 'other' ? other : null;
  const ownerOk = role === 'owner';
  // StudyAccessGuard пропускает: anonymous + public, owner всегда.
  const accessOk = role === 'owner' || isPublic;

  const study = { ...ownerStudy, isPublic };
  const studyDto = {
    ...study,
    createdAt: study.createdAt.toISOString(),
    updatedAt: study.updatedAt.toISOString(),
  };
  const chapterDto = {
    id: chapterId,
    studyId: study.id,
    name: 'C1',
    orderIdx: 1000,
    pgn: '1. e4 *',
    startFen: null,
    orientation: 'white',
    mode: 'analysis',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const studySvc = {
    list: jest.fn(async () => ({ data: [studyDto] })),
    getBySlug: jest.fn(async () => ({ study: studyDto, chapters: [] })),
    create: jest.fn(async () => studyDto),
    update: jest.fn(async () => studyDto),
    delete: jest.fn(async () => undefined),
    resolveBySlug: jest.fn(async () => study),
    requireOwn: jest.fn(async () => study),
  };
  const chaptersSvc = {
    getById: jest.fn(async () => chapterDto),
    create: jest.fn(async () => chapterDto),
    update: jest.fn(async () => chapterDto),
    delete: jest.fn(async () => undefined),
    reorder: jest.fn(async () => chapterDto),
    importPgn: jest.fn(async () => ({ created: [chapterDto] })),
    exportStudyPgn: jest.fn(async () => '[Event "X"] *'),
    exportChapterPgn: jest.fn(async () => '1. e4 *'),
  };

  const module = await Test.createTestingModule({
    controllers: [StudyController],
    providers: [
      { provide: StudyService, useValue: studySvc },
      { provide: StudyChaptersService, useValue: chaptersSvc },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue(userId ? new AttachUserGuard(userId) : new DenyGuard())
    .overrideGuard(OptionalJwtAuthGuard)
    .useValue(new AttachUserGuard(userId))
    .overrideGuard(StudyAccessGuard)
    .useValue(accessOk ? new AllowGuard() : new DenyGuard())
    .overrideGuard(StudyOwnerGuard)
    .useValue(ownerOk ? new AllowGuard() : new DenyGuard())
    .compile();
  const app = module.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

describe('Studies — permissions matrix (KS-2822 T7)', () => {
  let app: INestApplication;
  afterEach(async () => {
    if (app) await app.close();
  });

  // ── GET /studies ───────────────────────────────────────────────────
  describe('GET /studies (mine=0, public catalog)', () => {
    it.each<[Role, number]>([
      ['anonymous', 200],
      ['owner', 200],
      ['other', 200],
    ])('%s → %d', async (role, code) => {
      app = await appFor(role, true);
      await request(app.getHttpServer())
        .get('/studies?mine=0')
        .expect(code);
    });
  });

  describe('GET /studies (mine=1, мои)', () => {
    it('anonymous → 400 (мине требует auth, сервис кидает)', async () => {
      // OptionalJwtAuth пускает anonymous; сервис get(null, mine:true)
      // в реальности кинул бы BadRequest. Мокаем сервис так, чтобы
      // повторить это поведение.
      app = await Test.createTestingModule({
        controllers: [StudyController],
        providers: [
          {
            provide: StudyService,
            useValue: {
              list: jest.fn(async () => {
                throw new (await import('@nestjs/common')).BadRequestException(
                  'mine=1 requires authentication',
                );
              }),
              getBySlug: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
              delete: jest.fn(),
              resolveBySlug: jest.fn(),
              requireOwn: jest.fn(),
            },
          },
          { provide: StudyChaptersService, useValue: {} },
        ],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue(new AttachUserGuard(null))
        .overrideGuard(OptionalJwtAuthGuard)
        .useValue(new AttachUserGuard(null))
        .overrideGuard(StudyAccessGuard)
        .useValue(new AllowGuard())
        .overrideGuard(StudyOwnerGuard)
        .useValue(new AllowGuard())
        .compile()
        .then(async (m) => {
          const a = m.createNestApplication();
          await a.init();
          return a;
        });
      await request(app.getHttpServer())
        .get('/studies?mine=1')
        .expect(400);
    });
  });

  // ── POST /studies ─────────────────────────────────────────────────
  describe('POST /studies', () => {
    it.each<[Role, number]>([
      ['anonymous', 403],
      ['owner', 201],
      ['other', 201],
    ])('%s → %d', async (role, code) => {
      app = await appFor(role, false);
      await request(app.getHttpServer())
        .post('/studies')
        .send({ name: 'X' })
        .expect(code);
    });
  });

  // ── GET /studies/:slug ────────────────────────────────────────────
  describe('GET /studies/:slug (приватная)', () => {
    it.each<[Role, number]>([
      ['anonymous', 403],
      ['owner', 200],
      ['other', 403],
    ])('%s → %d', async (role, code) => {
      app = await appFor(role, false);
      await request(app.getHttpServer())
        .get(`/studies/${slug}`)
        .expect(code);
    });
  });

  describe('GET /studies/:slug (публичная)', () => {
    it.each<[Role, number]>([
      ['anonymous', 200],
      ['owner', 200],
      ['other', 200],
    ])('%s → %d', async (role, code) => {
      app = await appFor(role, true);
      await request(app.getHttpServer())
        .get(`/studies/${slug}`)
        .expect(code);
    });
  });

  // ── PATCH /studies/:slug ──────────────────────────────────────────
  describe('PATCH /studies/:slug', () => {
    it.each<[Role, number]>([
      ['anonymous', 403],
      ['owner', 200],
      ['other', 403],
    ])('%s → %d', async (role, code) => {
      app = await appFor(role, false);
      await request(app.getHttpServer())
        .patch(`/studies/${slug}`)
        .send({ name: 'X' })
        .expect(code);
    });
  });

  // ── DELETE /studies/:slug ─────────────────────────────────────────
  describe('DELETE /studies/:slug', () => {
    it.each<[Role, number]>([
      ['anonymous', 403],
      ['owner', 204],
      ['other', 403],
    ])('%s → %d', async (role, code) => {
      app = await appFor(role, false);
      await request(app.getHttpServer())
        .delete(`/studies/${slug}`)
        .expect(code);
    });
  });

  // ── Chapters: POST /:slug/chapters ────────────────────────────────
  describe('POST /studies/:slug/chapters', () => {
    it.each<[Role, number]>([
      ['anonymous', 403],
      ['owner', 201],
      ['other', 403],
    ])('%s → %d', async (role, code) => {
      app = await appFor(role, false);
      await request(app.getHttpServer())
        .post(`/studies/${slug}/chapters`)
        .send({ name: 'C' })
        .expect(code);
    });
  });

  // ── GET chapter ────────────────────────────────────────────────────
  describe('GET /studies/:slug/chapters/:id (публичная студия)', () => {
    it.each<[Role, number]>([
      ['anonymous', 200],
      ['owner', 200],
      ['other', 200],
    ])('%s → %d', async (role, code) => {
      app = await appFor(role, true);
      await request(app.getHttpServer())
        .get(`/studies/${slug}/chapters/${chapterId}`)
        .expect(code);
    });
  });

  describe('GET /studies/:slug/chapters/:id (приватная студия)', () => {
    it.each<[Role, number]>([
      ['anonymous', 403],
      ['owner', 200],
      ['other', 403],
    ])('%s → %d', async (role, code) => {
      app = await appFor(role, false);
      await request(app.getHttpServer())
        .get(`/studies/${slug}/chapters/${chapterId}`)
        .expect(code);
    });
  });

  // ── PATCH chapter ─────────────────────────────────────────────────
  describe('PATCH /studies/:slug/chapters/:id', () => {
    it.each<[Role, number]>([
      ['anonymous', 403],
      ['owner', 200],
      ['other', 403],
    ])('%s → %d', async (role, code) => {
      app = await appFor(role, false);
      await request(app.getHttpServer())
        .patch(`/studies/${slug}/chapters/${chapterId}`)
        .send({ name: 'New' })
        .expect(code);
    });
  });

  // ── Reorder ───────────────────────────────────────────────────────
  describe('PATCH /studies/:slug/chapters/:id/order', () => {
    it.each<[Role, number]>([
      ['anonymous', 403],
      ['owner', 200],
      ['other', 403],
    ])('%s → %d', async (role, code) => {
      app = await appFor(role, false);
      await request(app.getHttpServer())
        .patch(`/studies/${slug}/chapters/${chapterId}/order`)
        .send({ after: null })
        .expect(code);
    });
  });

  // ── DELETE chapter ────────────────────────────────────────────────
  describe('DELETE /studies/:slug/chapters/:id', () => {
    it.each<[Role, number]>([
      ['anonymous', 403],
      ['owner', 204],
      ['other', 403],
    ])('%s → %d', async (role, code) => {
      app = await appFor(role, false);
      await request(app.getHttpServer())
        .delete(`/studies/${slug}/chapters/${chapterId}`)
        .expect(code);
    });
  });

  // ── Import / Export ───────────────────────────────────────────────
  describe('POST /studies/:slug/import-pgn', () => {
    it.each<[Role, number]>([
      ['anonymous', 403],
      ['owner', 201],
      ['other', 403],
    ])('%s → %d', async (role, code) => {
      app = await appFor(role, false);
      await request(app.getHttpServer())
        .post(`/studies/${slug}/import-pgn`)
        .send({ pgn: '[Event "X"] 1. e4 *' })
        .expect(code);
    });
  });

  describe('GET /studies/:slug/export.pgn (приватная)', () => {
    it.each<[Role, number]>([
      ['anonymous', 403],
      ['owner', 200],
      ['other', 403],
    ])('%s → %d', async (role, code) => {
      app = await appFor(role, false);
      await request(app.getHttpServer())
        .get(`/studies/${slug}/export.pgn`)
        .expect(code);
    });
  });

  describe('GET /studies/:slug/export.pgn (публичная)', () => {
    it.each<[Role, number]>([
      ['anonymous', 200],
      ['owner', 200],
      ['other', 200],
    ])('%s → %d', async (role, code) => {
      app = await appFor(role, true);
      await request(app.getHttpServer())
        .get(`/studies/${slug}/export.pgn`)
        .expect(code);
    });
  });
});
