/**
 * KS-2994 / ADR-060 §3.4 K4. Acceptance-тесты `StudyDto.likedByMe`.
 *
 * Покрытие по ТЗ:
 *  - anonymous (userId=null) → likedByMe всегда false; БД не дёргается.
 *  - auth user без лайка → false.
 *  - auth user с лайком → true.
 *  - На `catalog` (список N студий) — для каждой корректное значение
 *    по `study_likes(studyId, userId)`.
 *  - Также проверка для `getBySlug` (detail) и `listByUser` (профиль).
 *
 * Реализация в `StudyService.getLikedSet`: один SELECT по PK
 * `(userId, studyId)` в `study_likes`, результат — Set<string>.
 * Эквивалент EXISTS-фильтра, но без LEFT JOIN'а в Prisma findMany.
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
    // KS-3015: getViewerRoleMap ходит в study_members.
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

const userId = '11111111-1111-4111-a111-111111111111';
const otherUserId = '22222222-2222-4222-a222-222222222222';

function makeStudy(over: Partial<Record<string, unknown>> = {}): any {
  return {
    id: 'study-1',
    ownerId: userId,
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

describe('KS-2994 · StudyDto.likedByMe', () => {
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

  // ─── catalog ──────────────────────────────────────────────────────

  describe('catalog (sort=new — без $queryRawUnsafe)', () => {
    it('anonymous → likedByMe=false для всех, study_likes НЕ запрашивается', async () => {
      const rows = [makeStudy({ id: 's-1' }), makeStudy({ id: 's-2' })];
      prisma.study.findMany.mockResolvedValue(rows);
      prisma.study.count.mockResolvedValue(2);

      const r = await svc.catalog(null, { sort: 'new' });

      expect(r.items).toHaveLength(2);
      expect(r.items.every((s) => s.likedByMe === false)).toBe(true);
      // Для anon — нет запроса в study_likes (early return).
      expect(prisma.studyLike.findMany).not.toHaveBeenCalled();
    });

    it('auth user без лайков → likedByMe=false для всех', async () => {
      const rows = [makeStudy({ id: 's-1' }), makeStudy({ id: 's-2' })];
      prisma.study.findMany.mockResolvedValue(rows);
      prisma.study.count.mockResolvedValue(2);
      // study_likes возвращает пусто.
      prisma.studyLike.findMany.mockResolvedValue([]);

      const r = await svc.catalog(userId, { sort: 'new' });

      expect(r.items.every((s) => s.likedByMe === false)).toBe(true);
      expect(prisma.studyLike.findMany).toHaveBeenCalledWith({
        where: { userId, studyId: { in: ['s-1', 's-2'] } },
        select: { studyId: true },
      });
    });

    it('auth user с лайком на одной из N → likedByMe=true только у неё', async () => {
      const rows = [
        makeStudy({ id: 's-1' }),
        makeStudy({ id: 's-2' }),
        makeStudy({ id: 's-3' }),
      ];
      prisma.study.findMany.mockResolvedValue(rows);
      prisma.study.count.mockResolvedValue(3);
      // Пользователь лайкнул только s-2.
      prisma.studyLike.findMany.mockResolvedValue([{ studyId: 's-2' }]);

      const r = await svc.catalog(userId, { sort: 'new' });

      expect(r.items.map((s) => ({ id: s.id, likedByMe: s.likedByMe })))
        .toEqual([
          { id: 's-1', likedByMe: false },
          { id: 's-2', likedByMe: true },
          { id: 's-3', likedByMe: false },
        ]);
    });

    it('каталог из N=5 студий, лайкнуты 2 из них → корректно для каждой', async () => {
      const rows = Array.from({ length: 5 }, (_, i) =>
        makeStudy({ id: `s-${i + 1}` }),
      );
      prisma.study.findMany.mockResolvedValue(rows);
      prisma.study.count.mockResolvedValue(5);
      prisma.studyLike.findMany.mockResolvedValue([
        { studyId: 's-1' },
        { studyId: 's-4' },
      ]);

      const r = await svc.catalog(userId, { sort: 'popular' });

      expect(r.items.map((s) => s.likedByMe)).toEqual([
        true,  // s-1
        false, // s-2
        false, // s-3
        true,  // s-4
        false, // s-5
      ]);
    });

    it('пустой каталог (0 студий) → study_likes НЕ запрашивается', async () => {
      prisma.study.findMany.mockResolvedValue([]);
      prisma.study.count.mockResolvedValue(0);

      const r = await svc.catalog(userId, { sort: 'new' });

      expect(r.items).toEqual([]);
      // Нет id'ов для запроса — early return.
      expect(prisma.studyLike.findMany).not.toHaveBeenCalled();
    });
  });

  describe('catalog (sort=hot — через $queryRawUnsafe)', () => {
    it('auth user, лайк на 1 из 2 hot-студий → корректное значение', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([
        { id: 's-1' },
        { id: 's-2' },
      ]);
      prisma.study.findMany.mockResolvedValue([
        makeStudy({ id: 's-1' }),
        makeStudy({ id: 's-2' }),
      ]);
      prisma.study.count.mockResolvedValue(2);
      prisma.studyLike.findMany.mockResolvedValue([{ studyId: 's-1' }]);

      const r = await svc.catalog(userId, { sort: 'hot' });

      const map = new Map(r.items.map((s) => [s.id, s.likedByMe]));
      expect(map.get('s-1')).toBe(true);
      expect(map.get('s-2')).toBe(false);
    });

    it('anon hot — likedByMe=false для всех, без обращения к study_likes', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([{ id: 's-1' }]);
      prisma.study.findMany.mockResolvedValue([makeStudy({ id: 's-1' })]);
      prisma.study.count.mockResolvedValue(1);

      const r = await svc.catalog(null, { sort: 'hot' });

      expect(r.items[0].likedByMe).toBe(false);
      expect(prisma.studyLike.findMany).not.toHaveBeenCalled();
    });
  });

  // ─── getBySlug (detail) ─────────────────────────────────────────

  describe('getBySlug (detail)', () => {
    beforeEach(() => {
      prisma.study.findFirst.mockResolvedValue(makeStudy({ id: 'study-1' }));
    });

    it('anonymous → likedByMe=false', async () => {
      const r = await svc.getBySlug(null, 'abc-study');
      expect(r.study.likedByMe).toBe(false);
      expect(prisma.studyLike.findMany).not.toHaveBeenCalled();
    });

    it('auth user без лайка → false', async () => {
      prisma.studyLike.findMany.mockResolvedValue([]);
      const r = await svc.getBySlug(userId, 'abc-study');
      expect(r.study.likedByMe).toBe(false);
    });

    it('auth user с лайком → true', async () => {
      prisma.studyLike.findMany.mockResolvedValue([{ studyId: 'study-1' }]);
      const r = await svc.getBySlug(userId, 'abc-study');
      expect(r.study.likedByMe).toBe(true);
      // Запрос идёт по конкретному id.
      expect(prisma.studyLike.findMany).toHaveBeenCalledWith({
        where: { userId, studyId: { in: ['study-1'] } },
        select: { studyId: true },
      });
    });
  });

  // ─── listByUser (профиль пользователя) ──────────────────────────

  describe('listByUser', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({
        id: userId,
        username: 'alice',
      });
    });

    it('anonymous caller → likedByMe=false для всех студий профиля', async () => {
      const rows = [makeStudy({ id: 's-1' }), makeStudy({ id: 's-2' })];
      prisma.study.findMany.mockResolvedValue(rows);
      prisma.study.count.mockResolvedValue(2);

      const r = await svc.listByUser(null, userId, {});

      expect(r.items.every((s) => s.likedByMe === false)).toBe(true);
      expect(prisma.studyLike.findMany).not.toHaveBeenCalled();
    });

    it('auth caller, лайкнул чужие → корректное значение per study', async () => {
      const rows = [
        makeStudy({ id: 's-1', ownerId: userId }),
        makeStudy({ id: 's-2', ownerId: userId }),
      ];
      prisma.study.findMany.mockResolvedValue(rows);
      prisma.study.count.mockResolvedValue(2);
      prisma.studyLike.findMany.mockResolvedValue([{ studyId: 's-2' }]);

      const r = await svc.listByUser(otherUserId, userId, {});

      expect(r.items.find((s) => s.id === 's-2')?.likedByMe).toBe(true);
      expect(r.items.find((s) => s.id === 's-1')?.likedByMe).toBe(false);
    });
  });

  // ─── list (mine / public) ───────────────────────────────────────

  describe('list', () => {
    it('mine=true: auth с лайком → likedByMe=true даже для своей студии', async () => {
      const rows = [makeStudy({ id: 's-1', ownerId: userId })];
      prisma.study.findMany.mockResolvedValue(rows);
      prisma.studyLike.findMany.mockResolvedValue([{ studyId: 's-1' }]);

      const r = await svc.list(userId, { mine: true });

      expect(r.data[0].likedByMe).toBe(true);
    });

    it('mine=false, anonymous → likedByMe=false без обращения к study_likes', async () => {
      const rows = [makeStudy({ id: 's-1' })];
      prisma.study.findMany.mockResolvedValue(rows);

      const r = await svc.list(null, { mine: false });

      expect(r.data[0].likedByMe).toBe(false);
      expect(prisma.studyLike.findMany).not.toHaveBeenCalled();
    });
  });

  // ─── getLikedSet — внутренний edge ──────────────────────────────

  describe('getLikedSet (internal)', () => {
    it('пустой studyIds → не дёргает study_likes', async () => {
      // Прямая проверка через listByUser с пустым findMany.
      prisma.user.findUnique.mockResolvedValue({
        id: userId,
        username: 'u',
      });
      prisma.study.findMany.mockResolvedValue([]);
      prisma.study.count.mockResolvedValue(0);

      await svc.listByUser(userId, userId, {});

      expect(prisma.studyLike.findMany).not.toHaveBeenCalled();
    });
  });
});
