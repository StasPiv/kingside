/**
 * KS-2856 / KS-2861 B5. Тесты `StudyMembersController` — happy-path,
 * 403/404 матрицы для likes/members/invites/gamebook.
 */
import { Test } from '@nestjs/testing';
import {
  CanActivate,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { StudyMembersController } from './study-members.controller';
import { StudyService } from './study.service';
import { StudyChaptersService } from './study-chapters.service';
import { StudyMembersService } from './study-members.service';
import { StudyLikesService } from './study-likes.service';
import { StudyInvitesService } from './study-invites.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  StudyAccessGuard,
  StudyResource,
} from './study-access.guard';
import { StudyOwnerGuard } from './study-owner.guard';
import { StudyContributorGuard } from './study-contributor.guard';

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
    req.user = this.userId ? { id: this.userId } : undefined;
    return true;
  }
}

const userId = 'user-owner';
const slug = 'abc-x';
const study: any = {
  id: 'study-1',
  ownerId: userId,
  slug,
  name: 'X',
  isPublic: false,
  visibility: 'private',
};

async function makeApp(opts: {
  authUserId: string | null;
  ownerOk: boolean;
  accessOk: boolean;
  contributorOk: boolean;
  studyOverrides?: Partial<StudyService>;
  membersOverrides?: Partial<StudyMembersService>;
  likesOverrides?: Partial<StudyLikesService>;
  invitesOverrides?: Partial<StudyInvitesService>;
  chaptersOverrides?: Partial<StudyChaptersService>;
  prismaOverrides?: Record<string, unknown>;
}): Promise<INestApplication> {
  const prismaDefaults: any = {
    study: {
      findFirst: jest.fn(async () => study),
    },
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
  };
  const studySvc = {
    resolveBySlug: jest.fn(async () => study),
    requireOwn: jest.fn(async () => study),
    ...opts.studyOverrides,
  };
  const chaptersSvc = {
    update: jest.fn(async () => ({})),
    ...opts.chaptersOverrides,
  };
  const membersSvc = {
    listMembers: jest.fn(async () => []),
    addContributor: jest.fn(async () => ({
      studyId: study.id,
      userId: 'u2',
      role: 'contributor',
    })),
    removeMember: jest.fn(async () => undefined),
    ...opts.membersOverrides,
  };
  const likesSvc = {
    toggle: jest.fn(async () => ({ liked: true, likes: 1 })),
    ...opts.likesOverrides,
  };
  const invitesSvc = {
    createInvite: jest.fn(async () => ({
      token: 'tok-' + 'x'.repeat(28),
      expiresAt: new Date('2026-06-01T00:00:00Z'),
    })),
    accept: jest.fn(async () => ({
      study,
      role: 'contributor' as const,
    })),
    ...opts.invitesOverrides,
  };
  const config: Partial<ConfigService> = {
    get: ((key: string) =>
      key === 'FRONTEND_URL' ? 'https://example.org' : undefined) as any,
  };

  const module = await Test.createTestingModule({
    controllers: [StudyMembersController],
    providers: [
      { provide: StudyService, useValue: studySvc },
      { provide: StudyChaptersService, useValue: chaptersSvc },
      { provide: StudyMembersService, useValue: membersSvc },
      { provide: StudyLikesService, useValue: likesSvc },
      { provide: StudyInvitesService, useValue: invitesSvc },
      {
        provide: PrismaService,
        useValue: { ...prismaDefaults, ...opts.prismaOverrides },
      },
      { provide: ConfigService, useValue: config },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue(
      opts.authUserId
        ? new AttachUserGuard(opts.authUserId)
        : new DenyGuard(),
    )
    .overrideGuard(StudyAccessGuard)
    .useValue(opts.accessOk ? new AllowGuard() : new DenyGuard())
    .overrideGuard(StudyOwnerGuard)
    .useValue(opts.ownerOk ? new AllowGuard() : new DenyGuard())
    .overrideGuard(StudyContributorGuard)
    .useValue(opts.contributorOk ? new AllowGuard() : new DenyGuard())
    .compile();
  const app = module.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

describe('StudyMembersController — KS-2861 B5', () => {
  let app: INestApplication;
  afterEach(async () => {
    if (app) await app.close();
  });

  describe('POST /studies/:slug/like', () => {
    it('reader → toggle ok', async () => {
      app = await makeApp({
        authUserId: 'u2',
        ownerOk: false,
        accessOk: true,
        contributorOk: false,
      });
      const res = await request(app.getHttpServer())
        .post(`/studies/${slug}/like`)
        .expect(201);
      expect(res.body).toEqual({ liked: true, likes: 1 });
    });

    it('без auth → 403', async () => {
      app = await makeApp({
        authUserId: null,
        ownerOk: false,
        accessOk: true,
        contributorOk: false,
      });
      await request(app.getHttpServer())
        .post(`/studies/${slug}/like`)
        .expect(403);
    });

    it('access denied → 403', async () => {
      app = await makeApp({
        authUserId: 'u3',
        ownerOk: false,
        accessOk: false,
        contributorOk: false,
      });
      await request(app.getHttpServer())
        .post(`/studies/${slug}/like`)
        .expect(403);
    });
  });

  describe('GET /studies/:slug/members', () => {
    it('reader → список', async () => {
      app = await makeApp({
        authUserId: 'u2',
        ownerOk: false,
        accessOk: true,
        contributorOk: false,
      });
      const res = await request(app.getHttpServer())
        .get(`/studies/${slug}/members`)
        .expect(200);
      expect(res.body).toEqual({ members: [] });
    });

    it('access denied → 403', async () => {
      app = await makeApp({
        authUserId: 'u3',
        ownerOk: false,
        accessOk: false,
        contributorOk: false,
      });
      await request(app.getHttpServer())
        .get(`/studies/${slug}/members`)
        .expect(403);
    });
  });

  describe('POST /studies/:slug/members (invite contributor)', () => {
    it('owner добавляет contributor по username', async () => {
      app = await makeApp({
        authUserId: userId,
        ownerOk: true,
        accessOk: true,
        contributorOk: true,
        prismaOverrides: {
          user: {
            findFirst: jest.fn(async () => ({ id: 'u2' })),
            findUnique: jest.fn(),
          },
        },
      });
      const res = await request(app.getHttpServer())
        .post(`/studies/${slug}/members`)
        .send({ userIdOrUsername: 'alice' })
        .expect(201);
      expect(res.body).toEqual({
        studyId: study.id,
        userId: 'u2',
        role: 'contributor',
      });
    });

    it('non-owner → 403', async () => {
      app = await makeApp({
        authUserId: 'u2',
        ownerOk: false,
        accessOk: true,
        contributorOk: true,
      });
      await request(app.getHttpServer())
        .post(`/studies/${slug}/members`)
        .send({ userIdOrUsername: 'bob' })
        .expect(403);
    });

    it('user не найден → 404', async () => {
      app = await makeApp({
        authUserId: userId,
        ownerOk: true,
        accessOk: true,
        contributorOk: true,
        prismaOverrides: {
          user: {
            findFirst: jest.fn(async () => null),
            findUnique: jest.fn(),
          },
        },
      });
      await request(app.getHttpServer())
        .post(`/studies/${slug}/members`)
        .send({ userIdOrUsername: 'ghost' })
        .expect(404);
    });

    it('owner добавляет себя → 400', async () => {
      app = await makeApp({
        authUserId: userId,
        ownerOk: true,
        accessOk: true,
        contributorOk: true,
        prismaOverrides: {
          user: {
            findFirst: jest.fn(async () => ({ id: userId })),
            findUnique: jest.fn(),
          },
        },
      });
      await request(app.getHttpServer())
        .post(`/studies/${slug}/members`)
        .send({ userIdOrUsername: 'me' })
        .expect(400);
    });
  });

  describe('DELETE /studies/:slug/members/:userId', () => {
    it('owner удаляет contributor → 204', async () => {
      app = await makeApp({
        authUserId: userId,
        ownerOk: true,
        accessOk: true,
        contributorOk: true,
      });
      await request(app.getHttpServer())
        .delete(`/studies/${slug}/members/u2`)
        .expect(204);
    });

    it('contributor сам уходит (self-leave) → 204', async () => {
      app = await makeApp({
        authUserId: 'u2',
        ownerOk: false,
        accessOk: true,
        contributorOk: true,
      });
      await request(app.getHttpServer())
        .delete(`/studies/${slug}/members/u2`)
        .expect(204);
    });

    it('outsider пытается удалить другого → 404', async () => {
      app = await makeApp({
        authUserId: 'u3',
        ownerOk: false,
        accessOk: true,
        contributorOk: false,
      });
      await request(app.getHttpServer())
        .delete(`/studies/${slug}/members/u2`)
        .expect(404);
    });
  });

  describe('POST /studies/:slug/invite-link', () => {
    it('owner получает ссылку с FRONTEND_URL', async () => {
      app = await makeApp({
        authUserId: userId,
        ownerOk: true,
        accessOk: true,
        contributorOk: true,
      });
      const res = await request(app.getHttpServer())
        .post(`/studies/${slug}/invite-link`)
        .expect(201);
      expect(res.body.token).toMatch(/^tok-/);
      expect(res.body.url).toMatch(/^https:\/\/example\.org\/studies\/invites\//);
      expect(res.body.expiresAt).toBe('2026-06-01T00:00:00.000Z');
    });

    it('non-owner → 403', async () => {
      app = await makeApp({
        authUserId: 'u2',
        ownerOk: false,
        accessOk: true,
        contributorOk: true,
      });
      await request(app.getHttpServer())
        .post(`/studies/${slug}/invite-link`)
        .expect(403);
    });
  });

  describe('POST /studies/invites/:token/accept', () => {
    it('JWT → принимает и становится contributor', async () => {
      app = await makeApp({
        authUserId: 'u2',
        ownerOk: false,
        accessOk: true,
        contributorOk: true,
      });
      const res = await request(app.getHttpServer())
        .post('/studies/invites/tok-abc/accept')
        .expect(201);
      expect(res.body).toEqual({
        studyId: study.id,
        slug,
        role: 'contributor',
      });
    });

    it('без auth → 403', async () => {
      app = await makeApp({
        authUserId: null,
        ownerOk: false,
        accessOk: true,
        contributorOk: true,
      });
      await request(app.getHttpServer())
        .post('/studies/invites/tok-abc/accept')
        .expect(403);
    });
  });

  describe('PATCH /studies/:slug/chapters/:chapterId/gamebook', () => {
    it('contributor обновляет payload', async () => {
      app = await makeApp({
        authUserId: 'u2',
        ownerOk: false,
        accessOk: true,
        contributorOk: true,
      });
      const res = await request(app.getHttpServer())
        .patch(`/studies/${slug}/chapters/ch1/gamebook`)
        .send({ gamebook: { intro: 'hello', byUci: { e2e4: { hint: 'go' } } } })
        .expect(200);
      expect(res.body).toEqual({});
    });

    it('outsider → 403', async () => {
      app = await makeApp({
        authUserId: 'u3',
        ownerOk: false,
        accessOk: true,
        contributorOk: false,
      });
      await request(app.getHttpServer())
        .patch(`/studies/${slug}/chapters/ch1/gamebook`)
        .send({ gamebook: {} })
        .expect(403);
    });

    it('invalid payload (ключ не похож на UCI) → 400', async () => {
      app = await makeApp({
        authUserId: 'u2',
        ownerOk: false,
        accessOk: true,
        contributorOk: true,
      });
      await request(app.getHttpServer())
        .patch(`/studies/${slug}/chapters/ch1/gamebook`)
        .send({ gamebook: { byUci: { xyz: { hint: 'x' } } } })
        .expect(400);
    });
  });
});
