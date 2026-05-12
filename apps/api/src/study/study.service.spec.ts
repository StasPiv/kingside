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
    },
    studyMember: {
      create: jest.fn(),
    },
  };
  const prisma: any = {
    study: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    studyChapter: {
      findMany: jest.fn(),
    },
    studyMember: {
      create: jest.fn(),
    },
    $transaction: jest.fn(async (cb: (tx: any) => Promise<unknown>) =>
      cb(txContext),
    ),
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
    svc = new StudyService(prisma as unknown as PrismaService, slug);
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
      expect(prisma.study.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isPublic: true } }),
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
      prisma.study.findFirst
        .mockResolvedValueOnce(null) // mine
        .mockResolvedValueOnce(null); // public
      const r = await svc.resolveBySlug(otherUserId, baseStudy.slug);
      expect(r).toBeNull();
    });

    it('anonymous видит публичную', async () => {
      const pub = { ...baseStudy, isPublic: true };
      prisma.study.findFirst.mockResolvedValueOnce(pub); // public
      const r = await svc.resolveBySlug(null, pub.slug);
      expect(r).toEqual(pub);
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
});
