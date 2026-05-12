/**
 * KS-2815 / KS-2819 T4. Контроллер Studies — happy-path и базовый
 * permissions matrix (403 без auth, 404 не-owner). Полная матрица
 * прав — отдельный спек в KS-2822 (T7).
 */
import { Test } from '@nestjs/testing';
import {
  CanActivate,
  INestApplication,
  NotFoundException,
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
import { StudyContributorGuard } from './study-contributor.guard';
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

const userId = '11111111-1111-4111-a111-111111111111';
const otherUserId = '22222222-2222-4222-a222-222222222222';

const baseStudyDto = {
  id: 'study-id',
  ownerId: userId,
  slug: 'abc-my-study',
  name: 'My Study',
  description: null,
  isPublic: false,
  visibility: 'private' as const,
  topics: [],
  likes: 0,
  fromKind: 'scratch',
  fromRefId: null,
  chaptersCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const baseStudy = {
  ...baseStudyDto,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
};

interface MakeAppOpts {
  authUserId?: string | null;
  ownerOk: boolean;
  accessOk: boolean;
  study?: Partial<StudyService>;
  chapters?: Partial<StudyChaptersService>;
}

async function makeApp(opts: MakeAppOpts): Promise<INestApplication> {
  const studyService = {
    list: jest.fn(async () => ({ data: [] })),
    getBySlug: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    resolveBySlug: jest.fn(async () => baseStudy),
    requireOwn: jest.fn(async () => baseStudy),
    // KS-2911: requireMember используется в chapter-mutating endpoints.
    requireMember: jest.fn(async () => baseStudy),
    ...opts.study,
  };
  const chaptersService = {
    getById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    reorder: jest.fn(),
    importPgn: jest.fn(),
    exportStudyPgn: jest.fn(),
    exportChapterPgn: jest.fn(),
    ...opts.chapters,
  };
  const module = await Test.createTestingModule({
    controllers: [StudyController],
    providers: [
      { provide: StudyService, useValue: studyService },
      { provide: StudyChaptersService, useValue: chaptersService },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue(
      opts.authUserId
        ? new AttachUserGuard(opts.authUserId)
        : new DenyGuard(),
    )
    .overrideGuard(OptionalJwtAuthGuard)
    .useValue(new AttachUserGuard(opts.authUserId ?? null))
    .overrideGuard(StudyAccessGuard)
    .useValue(opts.accessOk ? new AllowGuard() : new DenyGuard())
    .overrideGuard(StudyOwnerGuard)
    .useValue(opts.ownerOk ? new AllowGuard() : new DenyGuard())
    // KS-2911: chapter mutations переведены на StudyContributorGuard.
    // В этих тестах "owner" покрывает и contributor — переиспользуем
    // ownerOk флаг чтобы не плодить новый параметр.
    .overrideGuard(StudyContributorGuard)
    .useValue(opts.ownerOk ? new AllowGuard() : new DenyGuard())
    .compile();
  const app = module.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

describe('StudyController — KS-2819 T4', () => {
  let app: INestApplication;

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('POST /studies', () => {
    it('owner → создаётся студия', async () => {
      const create = jest.fn(async () => baseStudyDto);
      app = await makeApp({
        authUserId: userId,
        ownerOk: true,
        accessOk: true,
        study: { create },
      });
      const res = await request(app.getHttpServer())
        .post('/studies')
        .send({ name: 'My Study' })
        .expect(201);
      expect(res.body.id).toBe(baseStudyDto.id);
      expect(create).toHaveBeenCalledWith(userId, { name: 'My Study' });
    });

    it('без auth → 403 (JwtAuthGuard блокирует)', async () => {
      app = await makeApp({
        authUserId: null,
        ownerOk: true,
        accessOk: true,
      });
      await request(app.getHttpServer())
        .post('/studies')
        .send({ name: 'X' })
        .expect(403);
    });

    it('пустой name → 400 (ValidationPipe)', async () => {
      app = await makeApp({
        authUserId: userId,
        ownerOk: true,
        accessOk: true,
      });
      await request(app.getHttpServer())
        .post('/studies')
        .send({ name: 123 }) // не строка
        .expect(400);
    });
  });

  describe('GET /studies/:slug', () => {
    it('owner получает свою приватную', async () => {
      const getBySlug = jest.fn(async () => ({
        study: baseStudyDto,
        chapters: [],
      }));
      app = await makeApp({
        authUserId: userId,
        ownerOk: true,
        accessOk: true,
        study: { getBySlug },
      });
      const res = await request(app.getHttpServer())
        .get(`/studies/${baseStudyDto.slug}`)
        .expect(200);
      expect(res.body.study.id).toBe(baseStudyDto.id);
      expect(getBySlug).toHaveBeenCalledWith(userId, baseStudyDto.slug);
    });

    it('anonymous → public видит', async () => {
      const pubStudy = { ...baseStudyDto, isPublic: true };
      const getBySlug = jest.fn(async () => ({
        study: pubStudy,
        chapters: [],
      }));
      app = await makeApp({
        authUserId: null,
        ownerOk: false,
        accessOk: true,
        study: { getBySlug },
      });
      const res = await request(app.getHttpServer())
        .get(`/studies/${pubStudy.slug}`)
        .expect(200);
      expect(res.body.study.isPublic).toBe(true);
      expect(getBySlug).toHaveBeenCalledWith(null, pubStudy.slug);
    });

    it('anonymous → приватная чужая блокируется guard\'ом → 403/404', async () => {
      app = await makeApp({
        authUserId: null,
        ownerOk: false,
        accessOk: false,
      });
      await request(app.getHttpServer())
        .get(`/studies/${baseStudyDto.slug}`)
        .expect(403);
    });
  });

  describe('PATCH /studies/:slug', () => {
    it('owner → обновляется', async () => {
      const update = jest.fn(async () => ({ ...baseStudyDto, name: 'New' }));
      app = await makeApp({
        authUserId: userId,
        ownerOk: true,
        accessOk: true,
        study: { update },
      });
      const res = await request(app.getHttpServer())
        .patch(`/studies/${baseStudyDto.slug}`)
        .send({ name: 'New' })
        .expect(200);
      expect(res.body.name).toBe('New');
      expect(update).toHaveBeenCalledWith(userId, baseStudyDto.slug, {
        name: 'New',
      });
    });

    it('non-owner → 403 (StudyOwnerGuard)', async () => {
      app = await makeApp({
        authUserId: otherUserId,
        ownerOk: false,
        accessOk: true,
      });
      await request(app.getHttpServer())
        .patch(`/studies/${baseStudyDto.slug}`)
        .send({ name: 'X' })
        .expect(403);
    });
  });

  describe('DELETE /studies/:slug', () => {
    it('owner → 204', async () => {
      const del = jest.fn(async () => undefined);
      app = await makeApp({
        authUserId: userId,
        ownerOk: true,
        accessOk: true,
        study: { delete: del },
      });
      await request(app.getHttpServer())
        .delete(`/studies/${baseStudyDto.slug}`)
        .expect(204);
      expect(del).toHaveBeenCalledWith(userId, baseStudyDto.slug);
    });
  });

  describe('Chapters', () => {
    it('POST :slug/chapters owner → создаётся', async () => {
      const create = jest.fn(async () => ({
        id: 'ch1',
        studyId: baseStudyDto.id,
        name: 'C1',
        orderIdx: 1000,
        pgn: '',
        startFen: null,
        orientation: 'white',
        mode: 'analysis',
        concealPly: null,
        gamebook: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }));
      app = await makeApp({
        authUserId: userId,
        ownerOk: true,
        accessOk: true,
        chapters: { create },
      });
      const res = await request(app.getHttpServer())
        .post(`/studies/${baseStudyDto.slug}/chapters`)
        .send({ name: 'C1' })
        .expect(201);
      expect(res.body.name).toBe('C1');
      expect(create).toHaveBeenCalledWith(
        baseStudy,
        expect.objectContaining({ name: 'C1' }),
      );
    });

    it('PATCH chapter/:id/order owner → переупорядочивает', async () => {
      const reorder = jest.fn(async () => ({
        id: 'ch1',
        studyId: baseStudyDto.id,
        name: 'C1',
        orderIdx: 500,
        pgn: '',
        startFen: null,
        orientation: 'white',
        mode: 'analysis',
        concealPly: null,
        gamebook: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }));
      app = await makeApp({
        authUserId: userId,
        ownerOk: true,
        accessOk: true,
        chapters: { reorder },
      });
      const res = await request(app.getHttpServer())
        .patch(`/studies/${baseStudyDto.slug}/chapters/ch1/order`)
        .send({ after: null })
        .expect(200);
      expect(res.body.orderIdx).toBe(500);
      expect(reorder).toHaveBeenCalledWith(baseStudy, 'ch1', null);
    });

    it('DELETE chapter non-owner → 403', async () => {
      app = await makeApp({
        authUserId: otherUserId,
        ownerOk: false,
        accessOk: true,
      });
      await request(app.getHttpServer())
        .delete(`/studies/${baseStudyDto.slug}/chapters/ch1`)
        .expect(403);
    });

    it('GET chapter owner → отдаёт pgn', async () => {
      const getById = jest.fn(async () => ({
        id: 'ch1',
        studyId: baseStudyDto.id,
        name: 'C1',
        orderIdx: 1000,
        pgn: '1. e4 *',
        startFen: null,
        orientation: 'white',
        mode: 'analysis',
        concealPly: null,
        gamebook: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }));
      app = await makeApp({
        authUserId: userId,
        ownerOk: true,
        accessOk: true,
        chapters: { getById },
      });
      const res = await request(app.getHttpServer())
        .get(`/studies/${baseStudyDto.slug}/chapters/ch1`)
        .expect(200);
      expect(res.body.pgn).toBe('1. e4 *');
    });
  });

  describe('Import / Export (KS-2820 T5)', () => {
    it('POST import-pgn owner → возвращает created[]', async () => {
      const importPgn = jest.fn(async () => ({ created: [] }));
      app = await makeApp({
        authUserId: userId,
        ownerOk: true,
        accessOk: true,
        chapters: { importPgn },
      });
      await request(app.getHttpServer())
        .post(`/studies/${baseStudyDto.slug}/import-pgn`)
        .send({ pgn: '[Event "Test"] 1. e4 *' })
        .expect(201);
      expect(importPgn).toHaveBeenCalledWith(
        baseStudy,
        '[Event "Test"] 1. e4 *',
      );
    });

    it('GET :slug/export.pgn anonymous public → pgn-text', async () => {
      const exportStudyPgn = jest.fn(async () => '[Event "X"] *');
      app = await makeApp({
        authUserId: null,
        ownerOk: false,
        accessOk: true,
        chapters: { exportStudyPgn },
      });
      const res = await request(app.getHttpServer())
        .get(`/studies/${baseStudyDto.slug}/export.pgn`)
        .expect(200);
      expect(res.body.pgn).toBe('[Event "X"] *');
    });
  });
});
