/**
 * KS-3015 / ADR-060 §2.5. Acceptance-тесты `StudyDto.viewerRole`.
 *
 * Покрытие по ТЗ:
 *  - anon (currentUserId === null) → 'anon'.
 *  - auth owner (currentUserId === study.ownerId) → 'owner'.
 *  - auth contributor (запись в study_members с role='contributor') →
 *    'contributor'.
 *  - auth other (не owner и не member) → 'viewer'.
 *  - list/catalog с N студий разной роли — корректно per study.
 *
 * Реализация — `StudyService.getViewerRoleMap`: один SELECT по PK
 * `(userId, studyId)` в `study_members` (паттерн `getLikedSet` из
 * KS-2994). Анон обрабатывается без запроса в БД; owner определяется
 * локально по `ownerId` (избегаем второго round-trip'а).
 */
import { StudyService } from './study.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StudySlugService } from './study-slug.service';

function makePrisma(): any {
  return {
    study: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    studyChapter: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: jest.fn(),
    },
    studyLike: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    studyMember: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(async (arg: any) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      if (typeof arg === 'function') return arg({});
      return arg;
    }),
  };
}

function makeSlug(): any {
  return { generateUnique: jest.fn(), generate: jest.fn() };
}

function makeMembers(): any {
  return { getRole: jest.fn(async () => null) };
}

const ownerId = '11111111-1111-4111-a111-111111111111';
const contributorId = '22222222-2222-4222-a222-222222222222';
const viewerId = '33333333-3333-4333-a333-333333333333';

function makeStudy(over: Partial<Record<string, unknown>> = {}): any {
  return {
    id: 'study-1',
    ownerId,
    slug: 'abc-study',
    name: 'Study',
    description: null,
    isPublic: true,
    visibility: 'public',
    topics: [],
    likes: 0,
    fromKind: 'scratch',
    fromRefId: null,
    chaptersCount: 0,
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-02T00:00:00Z'),
    ...over,
  };
}

describe('KS-3015 · StudyDto.viewerRole', () => {
  let prisma: any;
  let svc: StudyService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new StudyService(
      prisma as unknown as PrismaService,
      makeSlug() as unknown as StudySlugService,
      makeMembers(),
    );
  });

  // ─── getBySlug (detail) ─────────────────────────────────────────

  describe('getBySlug — single study', () => {
    beforeEach(() => {
      prisma.study.findFirst.mockResolvedValue(makeStudy());
    });

    it('anonymous → viewerRole=anon, study_members НЕ дёргается', async () => {
      const r = await svc.getBySlug(null, 'abc-study');
      expect(r.study.viewerRole).toBe('anon');
      expect(prisma.studyMember.findMany).not.toHaveBeenCalled();
    });

    it('auth owner (userId === ownerId) → viewerRole=owner, БЕЗ запроса в study_members', async () => {
      const r = await svc.getBySlug(ownerId, 'abc-study');
      expect(r.study.viewerRole).toBe('owner');
      // Owner определяется локально по ownerId — нет SELECT'а.
      expect(prisma.studyMember.findMany).not.toHaveBeenCalled();
    });

    it('auth contributor → viewerRole=contributor (study_members.role="contributor")', async () => {
      prisma.studyMember.findMany.mockResolvedValue([
        { studyId: 'study-1', role: 'contributor' },
      ]);
      const r = await svc.getBySlug(contributorId, 'abc-study');
      expect(r.study.viewerRole).toBe('contributor');
      // SELECT идёт только для не-owner'ов.
      expect(prisma.studyMember.findMany).toHaveBeenCalledWith({
        where: { userId: contributorId, studyId: { in: ['study-1'] } },
        select: { studyId: true, role: true },
      });
    });

    it('auth other (не owner и не member) → viewerRole=viewer', async () => {
      prisma.studyMember.findMany.mockResolvedValue([]); // нет роли
      const r = await svc.getBySlug(viewerId, 'abc-study');
      expect(r.study.viewerRole).toBe('viewer');
    });

    it('study_members с role="owner" (расхождение с ownerId) → viewerRole=owner', async () => {
      // Защитная ветка: если caller попал в members с role=owner,
      // отдаём 'owner' даже если formal ownerId не совпадает.
      prisma.studyMember.findMany.mockResolvedValue([
        { studyId: 'study-1', role: 'owner' },
      ]);
      const r = await svc.getBySlug(contributorId, 'abc-study');
      expect(r.study.viewerRole).toBe('owner');
    });
  });

  // ─── catalog list (N студий) ────────────────────────────────────

  describe('catalog — list of N studies', () => {
    it('anon caller → все viewerRole=anon, БЕЗ запроса в study_members', async () => {
      const rows = [
        makeStudy({ id: 's-1', ownerId: 'u-a' }),
        makeStudy({ id: 's-2', ownerId: 'u-b' }),
      ];
      prisma.study.findMany.mockResolvedValue(rows);
      prisma.study.count.mockResolvedValue(2);

      const r = await svc.catalog(null, { sort: 'new' });

      expect(r.items.every((s) => s.viewerRole === 'anon')).toBe(true);
      expect(prisma.studyMember.findMany).not.toHaveBeenCalled();
    });

    it('auth с разными ролями в каждой из N=4 студий — корректно per study', async () => {
      // s-1: caller = owner; s-2: contributor; s-3: viewer (без member);
      // s-4: ещё один где caller тоже owner.
      const callerId = 'caller-uuid';
      const rows = [
        makeStudy({ id: 's-1', ownerId: callerId }), // owner
        makeStudy({ id: 's-2', ownerId: 'someone-else' }), // contributor
        makeStudy({ id: 's-3', ownerId: 'someone-else' }), // viewer
        makeStudy({ id: 's-4', ownerId: callerId }), // owner
      ];
      prisma.study.findMany.mockResolvedValue(rows);
      prisma.study.count.mockResolvedValue(4);
      // SELECT идёт только для не-owner id'ов: s-2 и s-3.
      prisma.studyMember.findMany.mockResolvedValue([
        { studyId: 's-2', role: 'contributor' },
        // s-3 нет → viewer.
      ]);

      const r = await svc.catalog(callerId, { sort: 'new' });

      expect(r.items.map((s) => ({ id: s.id, role: s.viewerRole })))
        .toEqual([
          { id: 's-1', role: 'owner' },
          { id: 's-2', role: 'contributor' },
          { id: 's-3', role: 'viewer' },
          { id: 's-4', role: 'owner' },
        ]);

      // study_members запрашивается только для не-owner id'ов (s-2, s-3).
      expect(prisma.studyMember.findMany).toHaveBeenCalledWith({
        where: { userId: callerId, studyId: { in: ['s-2', 's-3'] } },
        select: { studyId: true, role: true },
      });
    });

    it('auth caller — все студии его → study_members НЕ дёргается (все owner локально)', async () => {
      const callerId = 'caller-uuid';
      const rows = [
        makeStudy({ id: 's-1', ownerId: callerId }),
        makeStudy({ id: 's-2', ownerId: callerId }),
      ];
      prisma.study.findMany.mockResolvedValue(rows);
      prisma.study.count.mockResolvedValue(2);

      const r = await svc.catalog(callerId, { sort: 'new' });

      expect(r.items.every((s) => s.viewerRole === 'owner')).toBe(true);
      // Все owner локально → нет запроса в БД.
      expect(prisma.studyMember.findMany).not.toHaveBeenCalled();
    });

    it('пустой каталог → study_members НЕ дёргается', async () => {
      prisma.study.findMany.mockResolvedValue([]);
      prisma.study.count.mockResolvedValue(0);

      const r = await svc.catalog('caller', { sort: 'new' });

      expect(r.items).toEqual([]);
      expect(prisma.studyMember.findMany).not.toHaveBeenCalled();
    });

    it('sort=hot — viewerRole тоже проставляется корректно', async () => {
      const callerId = 'caller-uuid';
      prisma.$queryRawUnsafe.mockResolvedValue([
        { id: 's-1' },
        { id: 's-2' },
      ]);
      prisma.study.findMany.mockResolvedValue([
        makeStudy({ id: 's-1', ownerId: callerId }),
        makeStudy({ id: 's-2', ownerId: 'other' }),
      ]);
      prisma.study.count.mockResolvedValue(2);
      prisma.studyMember.findMany.mockResolvedValue([
        { studyId: 's-2', role: 'contributor' },
      ]);

      const r = await svc.catalog(callerId, { sort: 'hot' });

      const map = new Map(r.items.map((s) => [s.id, s.viewerRole]));
      expect(map.get('s-1')).toBe('owner');
      expect(map.get('s-2')).toBe('contributor');
    });
  });

  // ─── listByUser (профиль) ───────────────────────────────────────

  describe('listByUser', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({
        id: ownerId,
        username: 'alice',
      });
    });

    it('anon caller → все anon', async () => {
      const rows = [makeStudy({ id: 's-1' }), makeStudy({ id: 's-2' })];
      prisma.study.findMany.mockResolvedValue(rows);
      prisma.study.count.mockResolvedValue(2);

      const r = await svc.listByUser(null, ownerId, {});

      expect(r.items.every((s) => s.viewerRole === 'anon')).toBe(true);
      expect(prisma.studyMember.findMany).not.toHaveBeenCalled();
    });

    it('caller просматривает свой профиль → все owner', async () => {
      const rows = [
        makeStudy({ id: 's-1', ownerId }),
        makeStudy({ id: 's-2', ownerId }),
      ];
      prisma.study.findMany.mockResolvedValue(rows);
      prisma.study.count.mockResolvedValue(2);

      const r = await svc.listByUser(ownerId, ownerId, {});

      expect(r.items.every((s) => s.viewerRole === 'owner')).toBe(true);
      expect(prisma.studyMember.findMany).not.toHaveBeenCalled();
    });

    it('caller — viewer для чужого профиля без членства', async () => {
      const rows = [makeStudy({ id: 's-1', ownerId })];
      prisma.study.findMany.mockResolvedValue(rows);
      prisma.study.count.mockResolvedValue(1);

      const r = await svc.listByUser(viewerId, ownerId, {});

      expect(r.items[0].viewerRole).toBe('viewer');
    });
  });

  // ─── list (mine / public) ───────────────────────────────────────

  describe('list', () => {
    it('mine=true: caller всегда owner', async () => {
      prisma.study.findMany.mockResolvedValue([
        makeStudy({ id: 's-1', ownerId }),
      ]);

      const r = await svc.list(ownerId, { mine: true });

      expect(r.data[0].viewerRole).toBe('owner');
    });

    it('mine=false, anonymous → все anon', async () => {
      prisma.study.findMany.mockResolvedValue([makeStudy({ id: 's-1' })]);

      const r = await svc.list(null, { mine: false });

      expect(r.data[0].viewerRole).toBe('anon');
      expect(prisma.studyMember.findMany).not.toHaveBeenCalled();
    });

    it('mine=false, auth caller — viewer для чужих публичных', async () => {
      prisma.study.findMany.mockResolvedValue([
        makeStudy({ id: 's-1', ownerId: 'other-1' }),
        makeStudy({ id: 's-2', ownerId: 'other-2' }),
      ]);
      prisma.studyMember.findMany.mockResolvedValue([]); // нет членств

      const r = await svc.list(viewerId, { mine: false });

      expect(r.data.every((s) => s.viewerRole === 'viewer')).toBe(true);
    });
  });

  // ─── create / update ────────────────────────────────────────────

  describe('write-mutations', () => {
    it('create: новая студия → viewerRole=owner (автор)', async () => {
      prisma.study.count.mockResolvedValue(0);
      const createdStudy = makeStudy({ id: 's-new', ownerId: 'caller' });
      prisma.$transaction.mockImplementation(async (cb: any) =>
        cb({
          study: { create: jest.fn().mockResolvedValue(createdStudy) },
          studyMember: { create: jest.fn() },
        }),
      );

      const r = await svc.create('caller', { name: 'New Study' });
      expect(r.viewerRole).toBe('owner');
    });

    it('update: caller прошёл requireOwn ⇒ viewerRole=owner', async () => {
      const callerId = 'caller-id';
      prisma.study.findFirst.mockResolvedValue(
        makeStudy({ id: 's-1', ownerId: callerId }),
      );
      prisma.study.update = jest.fn().mockResolvedValue(
        makeStudy({ id: 's-1', ownerId: callerId, name: 'Renamed' }),
      );

      const r = await svc.update(callerId, 'slug', { name: 'Renamed' });
      expect(r.viewerRole).toBe('owner');
      // study_members.findMany НЕ дёргается — owner вычислен локально
      // (через requireOwn).
      expect(prisma.studyMember.findMany).not.toHaveBeenCalled();
    });
  });
});
