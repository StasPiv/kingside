/**
 * KS-2815 / KS-2818 T3. Happy-path юнит-тесты `StudyService`.
 *
 * Permissions matrix покрывается отдельным контроллер-тестом в KS-2822
 * (T7). Здесь — только бизнес-логика сервиса (лимиты, slug, видимость).
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StudyService } from './study.service';
import { STUDY_LIMITS } from './study-limits';
import type { PrismaService } from '../prisma/prisma.service';
import type { StudySlugService } from './study-slug.service';

function makePrisma(): any {
  const txContext: any = {
    study: {
      create: jest.fn(),
      update: jest.fn(),
    },
    studyMember: {
      create: jest.fn(),
    },
    studyChapter: {
      create: jest.fn(),
    },
  };
  const prisma: any = {
    study: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    studyChapter: {
      findMany: jest.fn(),
      // KS-2882: fromAnalysis считает существующие главы и max(orderIdx).
      findFirst: jest.fn(),
      count: jest.fn(),
    },
    studyMember: {
      create: jest.fn(),
    },
    // KS-2881: listByUser использует prisma.user.findUnique для owner.
    user: {
      findUnique: jest.fn(),
    },
    // KS-2882: fromAnalysis грузит Analysis.
    analysis: {
      findUnique: jest.fn(),
    },
    // KS-2994: getLikedSet ходит в study_likes для POV likedByMe.
    studyLike: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    // KS-2880: catalog hot-sort использует $queryRawUnsafe для PG-формулы
    // (динамические WHERE-условия с параметризацией).
    $queryRawUnsafe: jest.fn(),
    // KS-2881: listByUser использует $transaction([findMany, count]).
    // Поддерживаем оба варианта: callback (для create) и array (для batch).
    $transaction: jest.fn(async (arg: any) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      if (typeof arg === 'function') return arg(txContext);
      return arg;
    }),
  };
  // exposing tx context so tests can configure inner mocks
  prisma.__tx = txContext;
  return prisma;
}

function makeSlug(): jest.Mocked<StudySlugService> {
  return {
    generate: jest.fn().mockReturnValue('abc123-mock'),
    generateUnique: jest.fn().mockResolvedValue('abc123-my-study'),
  } as unknown as jest.Mocked<StudySlugService>;
}

const userId = '11111111-1111-4111-a111-111111111111';
const otherUserId = '22222222-2222-4222-a222-222222222222';

const baseStudy = {
  id: '33333333-3333-4333-a333-333333333333',
  ownerId: userId,
  slug: 'abc123-my-study',
  name: 'My Study',
  description: null,
  isPublic: false,
  // KS-2857: Phase 2 поля.
  visibility: 'private',
  topics: [],
  likes: 0,
  fromKind: 'scratch',
  fromRefId: null,
  chaptersCount: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
};

describe('StudyService — KS-2818 T3', () => {
  let prisma: any;
  let slug: jest.Mocked<StudySlugService>;
  let svc: StudyService;

  beforeEach(() => {
    prisma = makePrisma();
    slug = makeSlug();
    // KS-2911: StudyService теперь зависит от StudyMembersService.
    // Для unit-тестов сервиса достаточно простого мока с getRole.
    const members = {
      getRole: jest.fn(async () => null),
    } as any;
    svc = new StudyService(prisma as unknown as PrismaService, slug, members);
  });

  describe('list', () => {
    it('mine=true → берёт студии по ownerId', async () => {
      prisma.study.findMany.mockResolvedValue([baseStudy]);
      const r = await svc.list(userId, { mine: true });
      expect(r.data).toHaveLength(1);
      expect(r.data[0].id).toBe(baseStudy.id);
      expect(prisma.study.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ownerId: userId },
          orderBy: { updatedAt: 'desc' },
        }),
      );
    });

    it('mine=false → берёт публичные', async () => {
      prisma.study.findMany.mockResolvedValue([
        { ...baseStudy, ownerId: otherUserId, isPublic: true },
      ]);
      const r = await svc.list(userId, { mine: false });
      expect(r.data).toHaveLength(1);
      // KS-2910: каталог фильтрует строго по visibility='public',
      // не по legacy isPublic (тот включает unlisted).
      expect(prisma.study.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { visibility: 'public' } }),
      );
    });

    it('mine=true без userId → 400', async () => {
      await expect(svc.list(null, { mine: true })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('limit клампится 1..50', async () => {
      prisma.study.findMany.mockResolvedValue([]);
      await svc.list(userId, { mine: true, limit: 9999 });
      expect(prisma.study.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50 }),
      );
      await svc.list(userId, { mine: true, limit: 0 });
      expect(prisma.study.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 1 }),
      );
    });

    it('KS-2910: каталог (mine=false) НЕ возвращает unlisted/private', async () => {
      // Эмулируем prisma слой: возвращаем то, что попадёт под фильтр.
      // Достаточно проверить SQL-фильтр where = {visibility: 'public'}.
      prisma.study.findMany.mockResolvedValue([
        { ...baseStudy, visibility: 'public', isPublic: true },
      ]);
      await svc.list(null, { mine: false });
      const callArg = prisma.study.findMany.mock.calls[0][0];
      expect(callArg.where).toEqual({ visibility: 'public' });
      // Сценарный sanity-check: даже если бы prisma вернул unlisted,
      // фильтр уже на уровне where отсечёт. (toStudyListItem пробрасывает
      // visibility, поэтому при разделении логики тест ловит регрессию).
    });
  });

  describe('create', () => {
    it('создаёт студию с slug-ом, default visibility=private, и owner-record в study_members', async () => {
      prisma.study.count.mockResolvedValue(0);
      prisma.__tx.study.create.mockResolvedValue(baseStudy);
      const r = await svc.create(userId, { name: 'My Study' });
      expect(slug.generateUnique).toHaveBeenCalledWith(userId, 'My Study');
      expect(prisma.__tx.study.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ownerId: userId,
            slug: 'abc123-my-study',
            name: 'My Study',
            description: null,
            isPublic: false,
            visibility: 'private',
            topics: [],
          }),
        }),
      );
      // KS-2859: owner-запись в study_members создаётся в той же транзакции.
      expect(prisma.__tx.studyMember.create).toHaveBeenCalledWith({
        data: { studyId: baseStudy.id, userId, role: 'owner' },
      });
      expect(r.slug).toBe('abc123-my-study');
    });

    it('400 при достижении лимита studiesPerUser', async () => {
      prisma.study.count.mockResolvedValue(STUDY_LIMITS.studiesPerUser);
      await expect(
        svc.create(userId, { name: 'Another' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.__tx.study.create).not.toHaveBeenCalled();
    });

    it('legacy isPublic=true → visibility=public + isPublic=true', async () => {
      prisma.study.count.mockResolvedValue(0);
      prisma.__tx.study.create.mockResolvedValue({
        ...baseStudy,
        isPublic: true,
        visibility: 'public',
      });
      await svc.create(userId, { name: 'Public', isPublic: true });
      expect(prisma.__tx.study.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            isPublic: true,
            visibility: 'public',
          }),
        }),
      );
    });

    it('KS-2859: visibility=unlisted имеет приоритет над isPublic', async () => {
      prisma.study.count.mockResolvedValue(0);
      prisma.__tx.study.create.mockResolvedValue({
        ...baseStudy,
        visibility: 'unlisted',
        isPublic: true,
      });
      await svc.create(userId, {
        name: 'X',
        visibility: 'unlisted',
        isPublic: false, // должен быть проигнорирован
      });
      expect(prisma.__tx.study.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            visibility: 'unlisted',
            isPublic: true, // = (visibility !== 'private')
          }),
        }),
      );
    });

    it('KS-2859: topics нормализуются (trim+lowercase+dedupe)', async () => {
      prisma.study.count.mockResolvedValue(0);
      prisma.__tx.study.create.mockResolvedValue(baseStudy);
      await svc.create(userId, {
        name: 'X',
        topics: ['  Opening  ', 'opening', 'ENDGAME', ''],
      });
      const data = prisma.__tx.study.create.mock.calls[0][0].data;
      expect(data.topics).toEqual(['opening', 'endgame']);
    });
  });

  describe('update', () => {
    it('партиально обновляет owner-студию', async () => {
      prisma.study.findFirst.mockResolvedValue(baseStudy);
      prisma.study.update.mockResolvedValue({ ...baseStudy, name: 'Renamed' });
      const r = await svc.update(userId, baseStudy.slug, { name: 'Renamed' });
      expect(prisma.study.update).toHaveBeenCalledWith({
        where: { id: baseStudy.id },
        data: { name: 'Renamed' },
      });
      expect(r.name).toBe('Renamed');
    });

    it('404 для slug, которого нет у юзера', async () => {
      prisma.study.findFirst.mockResolvedValue(null);
      await expect(
        svc.update(userId, 'unknown', { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('delete', () => {
    it('удаляет owner-студию', async () => {
      prisma.study.findFirst.mockResolvedValue(baseStudy);
      prisma.study.delete.mockResolvedValue(baseStudy);
      await svc.delete(userId, baseStudy.slug);
      expect(prisma.study.delete).toHaveBeenCalledWith({
        where: { id: baseStudy.id },
      });
    });
  });

  describe('resolveBySlug — видимость', () => {
    it('owner получает свою приватную', async () => {
      prisma.study.findFirst.mockResolvedValueOnce(baseStudy);
      const r = await svc.resolveBySlug(userId, baseStudy.slug);
      expect(r).toEqual(baseStudy);
    });

    it('чужой пользователь не видит чужую приватную', async () => {
      // KS-2911: 3 last вызова findFirst — mine / member-join / visible.
      prisma.study.findFirst
        .mockResolvedValueOnce(null) // mine
        .mockResolvedValueOnce(null) // member-join (KS-2911)
        .mockResolvedValueOnce(null); // public/unlisted
      const r = await svc.resolveBySlug(otherUserId, baseStudy.slug);
      expect(r).toBeNull();
    });

    it('anonymous видит публичную', async () => {
      const pub = { ...baseStudy, visibility: 'public', isPublic: true };
      prisma.study.findFirst.mockResolvedValueOnce(pub); // visible (public/unlisted)
      const r = await svc.resolveBySlug(null, pub.slug);
      expect(r).toEqual(pub);
    });

    it('KS-2911: contributor чужой private → видит', async () => {
      const other = { ...baseStudy, ownerId: otherUserId };
      prisma.study.findFirst
        .mockResolvedValueOnce(null) // mine (не owner)
        .mockResolvedValueOnce(other); // member-join возвращает студию
      const r = await svc.resolveBySlug(userId, baseStudy.slug);
      expect(r).toEqual(other);
    });

    it('KS-2911 / ADR-060 §2.6: unlisted anonymous → видит по ссылке', async () => {
      const un = { ...baseStudy, visibility: 'unlisted', isPublic: true };
      prisma.study.findFirst.mockResolvedValueOnce(un);
      const r = await svc.resolveBySlug(null, un.slug);
      expect(r).toEqual(un);
    });
  });

  describe('getBySlug', () => {
    it('возвращает study + chapters (без pgn)', async () => {
      prisma.study.findFirst.mockResolvedValueOnce(baseStudy);
      prisma.studyChapter.findMany.mockResolvedValue([
        {
          id: 'ch1',
          name: 'First',
          orderIdx: 1000,
          startFen: null,
          orientation: 'white',
          mode: 'analysis',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);
      const r = await svc.getBySlug(userId, baseStudy.slug);
      expect(r.study.id).toBe(baseStudy.id);
      expect(r.chapters).toHaveLength(1);
      expect(r.chapters[0].name).toBe('First');
      // Убеждаемся, что pgn не выбирается.
      const selectArg = (prisma.studyChapter.findMany as jest.Mock).mock.calls[0][0];
      expect(selectArg.select).not.toHaveProperty('pgn');
    });

    it('404 если slug не разрешается', async () => {
      prisma.study.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      await expect(svc.getBySlug(userId, 'x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ── KS-2880 / ADR-060 §3.4. Каталог публичных студий.
  // Проверяем: where всегда visibility='public'; q → ILIKE на name+description;
  // topic → topics.has; sort new/updated/popular → orderBy; sort=hot → $queryRaw
  // + добор полей через findMany по списку id с сохранением порядка.
  describe('catalog (KS-2880)', () => {
    const pubStudy = { ...baseStudy, visibility: 'public', isPublic: true };

    beforeEach(() => {
      prisma.study.count.mockResolvedValue(0);
      prisma.study.findMany.mockResolvedValue([]);
      prisma.$queryRawUnsafe.mockResolvedValue([]);
    });

    it('дефолт: sort=hot, page=1, pageSize=20; вызывает $queryRaw с public-фильтром', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([{ id: pubStudy.id }]);
      prisma.study.findMany.mockResolvedValue([pubStudy]);
      prisma.study.count.mockResolvedValue(1);

      const r = await svc.catalog(null, {});

      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
      // count с фильтром visibility=public
      expect(prisma.study.count).toHaveBeenCalledWith({
        where: { visibility: 'public' },
      });
      expect(r.items).toHaveLength(1);
      expect(r.items[0].id).toBe(pubStudy.id);
      expect(r.total).toBe(1);
      expect(r.hasMore).toBe(false);
    });

    it('sort=new → orderBy createdAt desc; пагинация page=2 pageSize=10 даёт skip=10 take=10', async () => {
      prisma.study.findMany.mockResolvedValueOnce([pubStudy]);
      prisma.study.count.mockResolvedValue(25);

      const r = await svc.catalog(null, { sort: 'new', page: 2, pageSize: 10 });

      const call = prisma.study.findMany.mock.calls[0][0];
      expect(call.orderBy).toEqual([{ createdAt: 'desc' }]);
      expect(call.where).toEqual({ visibility: 'public' });
      expect(call.skip).toBe(10);
      expect(call.take).toBe(10);
      expect(r.total).toBe(25);
      // 1 item на странице 2/10 → 25 total → hasMore: 10+1=11 < 25
      expect(r.hasMore).toBe(true);
    });

    it('sort=updated → orderBy updatedAt desc', async () => {
      await svc.catalog(null, { sort: 'updated' });
      const call = prisma.study.findMany.mock.calls[0][0];
      expect(call.orderBy).toEqual([{ updatedAt: 'desc' }]);
    });

    it('sort=popular → orderBy likes desc, updatedAt desc (tie-break)', async () => {
      await svc.catalog(null, { sort: 'popular' });
      const call = prisma.study.findMany.mock.calls[0][0];
      expect(call.orderBy).toEqual([
        { likes: 'desc' },
        { updatedAt: 'desc' },
      ]);
    });

    it('q добавляет OR ILIKE name+description (insensitive)', async () => {
      await svc.catalog(null, { sort: 'new', q: 'sicilian' });
      const call = prisma.study.findMany.mock.calls[0][0];
      expect(call.where).toEqual({
        visibility: 'public',
        OR: [
          { name: { contains: 'sicilian', mode: 'insensitive' } },
          { description: { contains: 'sicilian', mode: 'insensitive' } },
        ],
      });
    });

    it('q пустой/whitespace → НЕ добавляет OR', async () => {
      await svc.catalog(null, { sort: 'new', q: '   ' });
      const call = prisma.study.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ visibility: 'public' });
      expect(call.where.OR).toBeUndefined();
    });

    it('topic добавляет фильтр topics.has (PG @> ARRAY[$1])', async () => {
      await svc.catalog(null, { sort: 'new', topic: 'opening' });
      const call = prisma.study.findMany.mock.calls[0][0];
      expect(call.where).toEqual({
        visibility: 'public',
        topics: { has: 'opening' },
      });
    });

    it('q+topic — комбинация фильтров без потери visibility=public', async () => {
      await svc.catalog(null, { sort: 'popular', q: 'sicilian', topic: 'opening' });
      const call = prisma.study.findMany.mock.calls[0][0];
      expect(call.where).toEqual({
        visibility: 'public',
        OR: [
          { name: { contains: 'sicilian', mode: 'insensitive' } },
          { description: { contains: 'sicilian', mode: 'insensitive' } },
        ],
        topics: { has: 'opening' },
      });
    });

    it('pageSize клампится до max=50 даже если запросили больше', async () => {
      await svc.catalog(null, { sort: 'new', page: 1, pageSize: 999 });
      const call = prisma.study.findMany.mock.calls[0][0];
      expect(call.take).toBe(50);
    });

    it('page клампится до min=1 (через DTO @Min(1), здесь страховка)', async () => {
      await svc.catalog(null, { sort: 'new', page: 0, pageSize: 20 });
      const call = prisma.study.findMany.mock.calls[0][0];
      // clampInt(0,1,…) → 1; skip = (1-1)*20 = 0
      expect(call.skip).toBe(0);
    });

    it('hot: dual-query сохраняет порядок id из raw-результата', async () => {
      const a = { ...pubStudy, id: 'aaa', name: 'A' };
      const b = { ...pubStudy, id: 'bbb', name: 'B' };
      const c = { ...pubStudy, id: 'ccc', name: 'C' };
      // raw вернул порядок c,a,b (по hot-rate)
      prisma.$queryRawUnsafe.mockResolvedValue([
        { id: 'ccc' },
        { id: 'aaa' },
        { id: 'bbb' },
      ]);
      // findMany может вернуть в любом порядке
      prisma.study.findMany.mockResolvedValue([a, b, c]);
      prisma.study.count.mockResolvedValue(3);

      const r = await svc.catalog(null, { sort: 'hot' });

      expect(r.items.map((s) => s.id)).toEqual(['ccc', 'aaa', 'bbb']);
      expect(r.total).toBe(3);
      expect(r.hasMore).toBe(false);
    });

    it('hot: пустой результат не вызывает findMany добор', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([]);
      prisma.study.count.mockResolvedValue(0);

      const r = await svc.catalog(null, { sort: 'hot' });

      expect(r.items).toEqual([]);
      expect(prisma.study.findMany).not.toHaveBeenCalled();
    });

    it('hasMore=true когда skip+items.length < total', async () => {
      prisma.study.findMany.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => ({
          ...pubStudy,
          id: `id-${i}`,
        })),
      );
      prisma.study.count.mockResolvedValue(45);

      const r = await svc.catalog(null, { sort: 'new', page: 1, pageSize: 20 });

      expect(r.hasMore).toBe(true);
      expect(r.total).toBe(45);
      expect(r.items).toHaveLength(20);
    });

    it('hasMore=false на последней странице', async () => {
      prisma.study.findMany.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => ({ ...pubStudy, id: `id-${i}` })),
      );
      prisma.study.count.mockResolvedValue(25);

      const r = await svc.catalog(null, { sort: 'new', page: 2, pageSize: 20 });

      // skip=20 + 5 = 25 = total → hasMore=false
      expect(r.hasMore).toBe(false);
    });
  });

  // ── KS-2881 / ADR-060 §2.8 K6. Список студий конкретного пользователя.
  // Покрытие правил доступа:
  //  - anon → только public;
  //  - auth-other → только public (includePrivate игнорируется);
  //  - auth-self + includePrivate=1 → все visibility'и;
  //  - auth-self без includePrivate → только public;
  //  - 404 если user не найден.
  describe('listByUser (KS-2881)', () => {
    const targetUser = { id: userId, username: 'alice' };

    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue(targetUser);
      prisma.study.findMany.mockResolvedValue([]);
      prisma.study.count.mockResolvedValue(0);
    });

    it('anon → where = {ownerId, visibility: public}', async () => {
      await svc.listByUser(null, userId, {});
      const where = prisma.study.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ ownerId: userId, visibility: 'public' });
    });

    it('auth-other → where = {ownerId, visibility: public} даже при includePrivate=1', async () => {
      await svc.listByUser(otherUserId, userId, { includePrivate: '1' });
      const where = prisma.study.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ ownerId: userId, visibility: 'public' });
    });

    it('auth-self БЕЗ includePrivate → only public', async () => {
      await svc.listByUser(userId, userId, {});
      const where = prisma.study.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ ownerId: userId, visibility: 'public' });
    });

    it('auth-self + includePrivate=1 → все visibility', async () => {
      await svc.listByUser(userId, userId, { includePrivate: '1' });
      const where = prisma.study.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ ownerId: userId });
      expect(where.visibility).toBeUndefined();
    });

    it('auth-self + includePrivate=true (строка) тоже включает приватные', async () => {
      await svc.listByUser(userId, userId, { includePrivate: 'true' });
      expect(prisma.study.findMany.mock.calls[0][0].where.visibility).toBeUndefined();
    });

    it('auth-self + includePrivate=anything-else → public', async () => {
      await svc.listByUser(userId, userId, { includePrivate: 'yes' });
      const where = prisma.study.findMany.mock.calls[0][0].where;
      expect(where.visibility).toBe('public');
    });

    it('404 если user не найден', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(svc.listByUser(null, userId, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('orderBy=updatedAt desc + пагинация page=2 pageSize=10 → skip=10 take=10', async () => {
      await svc.listByUser(null, userId, { page: 2, pageSize: 10 });
      const call = prisma.study.findMany.mock.calls[0][0];
      expect(call.orderBy).toEqual({ updatedAt: 'desc' });
      expect(call.skip).toBe(10);
      expect(call.take).toBe(10);
    });

    it('pageSize клампится до max=50', async () => {
      await svc.listByUser(null, userId, { pageSize: 999 });
      expect(prisma.study.findMany.mock.calls[0][0].take).toBe(50);
    });

    it('response содержит owner: {id, username}', async () => {
      prisma.study.findMany.mockResolvedValue([baseStudy]);
      prisma.study.count.mockResolvedValue(1);
      const r = await svc.listByUser(null, userId, {});
      expect(r.owner).toEqual({ id: userId, username: 'alice' });
      expect(r.items).toHaveLength(1);
      expect(r.total).toBe(1);
      expect(r.hasMore).toBe(false);
    });

    it('owner.username=null когда у пользователя нет username (requires setup)', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: userId, username: null });
      const r = await svc.listByUser(null, userId, {});
      expect(r.owner).toEqual({ id: userId, username: null });
    });

    it('hasMore=true когда skip+items.length < total', async () => {
      prisma.study.findMany.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => ({ ...baseStudy, id: `s-${i}` })),
      );
      prisma.study.count.mockResolvedValue(45);
      const r = await svc.listByUser(null, userId, { page: 1, pageSize: 20 });
      expect(r.hasMore).toBe(true);
      expect(r.total).toBe(45);
    });
  });

  // ── KS-2882 / ADR-060 §3.6. Save-to-study из AnalysisPage.
  describe('fromAnalysis (KS-2882)', () => {
    const analysisId = '44444444-4444-4444-a444-444444444444';
    const studyId = '55555555-5555-5555-a555-555555555555';
    const chapterId = '66666666-6666-6666-a666-666666666666';

    const ownAnalysis = {
      id: analysisId,
      userId,
      title: 'My analysis',
      pgn: '1. e4 e5 *',
      fen: null,
      isPublic: false,
      createdAt: new Date('2026-05-10T12:34:56Z'),
    };

    beforeEach(() => {
      prisma.analysis.findUnique.mockResolvedValue(ownAnalysis);
      prisma.study.findUnique.mockResolvedValue({ ...baseStudy, id: studyId });
      prisma.studyChapter.count.mockResolvedValue(0);
      prisma.studyChapter.findFirst.mockResolvedValue({ orderIdx: 0 });
      prisma.__tx.studyChapter.create.mockResolvedValue({ id: chapterId });
      prisma.__tx.study.create.mockResolvedValue({
        ...baseStudy,
        id: studyId,
        slug: 'abc123-new',
      });
      prisma.study.count.mockResolvedValue(0);
    });

    it('400 если оба studyId и newStudyName не заданы', async () => {
      await expect(svc.fromAnalysis(userId, { analysisId })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('400 если оба studyId и newStudyName заданы', async () => {
      await expect(
        svc.fromAnalysis(userId, {
          analysisId,
          studyId,
          newStudyName: 'X',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404 если анализ не найден', async () => {
      prisma.analysis.findUnique.mockResolvedValue(null);
      await expect(
        svc.fromAnalysis(userId, { analysisId, newStudyName: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404 если анализ не свой и не public', async () => {
      prisma.analysis.findUnique.mockResolvedValue({
        ...ownAnalysis,
        userId: otherUserId,
        isPublic: false,
      });
      await expect(
        svc.fromAnalysis(userId, { analysisId, newStudyName: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('public-анализ другого пользователя — разрешён', async () => {
      prisma.analysis.findUnique.mockResolvedValue({
        ...ownAnalysis,
        userId: otherUserId,
        isPublic: true,
      });
      const r = await svc.fromAnalysis(userId, {
        analysisId,
        newStudyName: 'From public',
      });
      expect(r.chapterId).toBe(chapterId);
    });

    // ─── ветка newStudyName ──────────────────────────────────────────
    it('newStudyName: создаёт private-студию с fromKind=analysis:<id>', async () => {
      await svc.fromAnalysis(userId, {
        analysisId,
        newStudyName: 'New study',
      });
      const data = prisma.__tx.study.create.mock.calls[0][0].data;
      expect(data.ownerId).toBe(userId);
      expect(data.name).toBe('New study');
      expect(data.visibility).toBe('private');
      expect(data.isPublic).toBe(false);
      expect(data.fromKind).toBe(`analysis:${analysisId}`);
      expect(data.fromRefId).toBe(analysisId);
      expect(data.chaptersCount).toBe(1);
    });

    it('newStudyName: создаётся owner-record в study_members', async () => {
      await svc.fromAnalysis(userId, {
        analysisId,
        newStudyName: 'New study',
      });
      expect(prisma.__tx.studyMember.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId, role: 'owner' }),
      });
    });

    it('newStudyName: глава получает Analysis.title и pgn копируется', async () => {
      await svc.fromAnalysis(userId, {
        analysisId,
        newStudyName: 'New study',
      });
      const chapterData = prisma.__tx.studyChapter.create.mock.calls[0][0].data;
      expect(chapterData.name).toBe('My analysis');
      expect(chapterData.pgn).toBe('1. e4 e5 *');
      expect(chapterData.mode).toBe('analysis');
    });

    it('newStudyName: если Analysis.title пуст — имя «Analysis from <date>»', async () => {
      prisma.analysis.findUnique.mockResolvedValue({
        ...ownAnalysis,
        title: '',
      });
      await svc.fromAnalysis(userId, {
        analysisId,
        newStudyName: 'New study',
      });
      const chapterData = prisma.__tx.studyChapter.create.mock.calls[0][0].data;
      expect(chapterData.name).toBe('Analysis from 2026-05-10');
    });

    it('newStudyName: 400 при превышении лимита studiesPerUser', async () => {
      prisma.study.count.mockResolvedValue(STUDY_LIMITS.studiesPerUser);
      await expect(
        svc.fromAnalysis(userId, { analysisId, newStudyName: 'X' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.__tx.study.create).not.toHaveBeenCalled();
    });

    it('newStudyName: response {studyId, slug, chapterId}', async () => {
      const r = await svc.fromAnalysis(userId, {
        analysisId,
        newStudyName: 'New study',
      });
      expect(r).toEqual({
        studyId,
        slug: 'abc123-new',
        chapterId,
      });
    });

    // ─── ветка studyId ───────────────────────────────────────────────
    it('studyId: owner — добавляет главу с orderIdx=max+STUDY_ORDER_STEP', async () => {
      prisma.studyChapter.findFirst.mockResolvedValue({ orderIdx: 3000 });
      await svc.fromAnalysis(userId, { analysisId, studyId });
      const chapterData = prisma.__tx.studyChapter.create.mock.calls[0][0].data;
      expect(chapterData.studyId).toBe(studyId);
      expect(chapterData.orderIdx).toBe(4000); // 3000 + 1000
      // chaptersCount инкрементируется в студии
      expect(prisma.__tx.study.update).toHaveBeenCalledWith({
        where: { id: studyId },
        data: { chaptersCount: { increment: 1 } },
      });
    });

    it('studyId: contributor — допускается', async () => {
      prisma.study.findUnique.mockResolvedValue({
        ...baseStudy,
        id: studyId,
        ownerId: otherUserId, // не owner
      });
      // mock members.getRole возвращает 'contributor'
      (svc as any).members.getRole.mockResolvedValueOnce('contributor');
      const r = await svc.fromAnalysis(userId, { analysisId, studyId });
      expect(r.chapterId).toBe(chapterId);
    });

    it('studyId: posторонний (не member) → 404', async () => {
      prisma.study.findUnique.mockResolvedValue({
        ...baseStudy,
        id: studyId,
        ownerId: otherUserId,
      });
      (svc as any).members.getRole.mockResolvedValueOnce(null);
      await expect(
        svc.fromAnalysis(userId, { analysisId, studyId }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('studyId: spectator (role!=owner/contributor) → 404', async () => {
      prisma.study.findUnique.mockResolvedValue({
        ...baseStudy,
        id: studyId,
        ownerId: otherUserId,
      });
      (svc as any).members.getRole.mockResolvedValueOnce('spectator' as any);
      await expect(
        svc.fromAnalysis(userId, { analysisId, studyId }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('studyId: 404 если студия не найдена', async () => {
      prisma.study.findUnique.mockResolvedValue(null);
      await expect(
        svc.fromAnalysis(userId, { analysisId, studyId }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('studyId: 400 при достижении лимита chaptersPerStudy=64', async () => {
      prisma.studyChapter.count.mockResolvedValue(
        STUDY_LIMITS.chaptersPerStudy,
      );
      await expect(
        svc.fromAnalysis(userId, { analysisId, studyId }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.__tx.studyChapter.create).not.toHaveBeenCalled();
    });
  });
});
