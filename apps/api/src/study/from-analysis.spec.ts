/**
 * KS-2885 / ADR-060 §10.2 B12. Acceptance-тесты `StudyService.fromAnalysis()`.
 *
 * Покрытие по ТЗ:
 *  - create new study (newStudyName) — fromKind/fromRefId/owner-member;
 *  - add to existing (studyId) — owner + contributor допускаются;
 *  - лимит 64 (`STUDY_LIMITS.chaptersPerStudy`);
 *  - запрет: outsider / spectator / 404 analysis;
 *  - имя главы fallback'ит к «Analysis from <date>» при пустом title.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StudyService } from './study.service';
import { STUDY_LIMITS, STUDY_ORDER_STEP } from './study-limits';
import type { PrismaService } from '../prisma/prisma.service';
import type { StudySlugService } from './study-slug.service';

function makePrisma(): any {
  const tx: any = {
    study: { create: jest.fn(), update: jest.fn() },
    studyMember: { create: jest.fn() },
    studyChapter: { create: jest.fn() },
  };
  const prisma: any = {
    study: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    studyChapter: {
      findFirst: jest.fn().mockResolvedValue({ orderIdx: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    analysis: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(async (arg: any) => {
      if (typeof arg === 'function') return arg(tx);
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg;
    }),
  };
  prisma.__tx = tx;
  return prisma;
}

function makeSlug(): any {
  return {
    generateUnique: jest.fn().mockResolvedValue('analysis-slug-xyz'),
  };
}

const userId = '11111111-1111-4111-a111-111111111111';
const otherUserId = '22222222-2222-4222-a222-222222222222';
const analysisId = '44444444-4444-4444-a444-444444444444';
const studyId = '55555555-5555-5555-a555-555555555555';
const chapterId = '66666666-6666-6666-a666-666666666666';

const ownAnalysis = {
  id: analysisId,
  userId,
  title: 'My analysis',
  pgn: '1. e4 e5 2. Nf3 *',
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  isPublic: false,
  createdAt: new Date('2026-05-10T12:34:56Z'),
};

const baseStudy = {
  id: studyId,
  ownerId: userId,
  slug: 'existing-study',
  name: 'Existing Study',
  description: null,
  isPublic: false,
  visibility: 'private',
  topics: [],
  likes: 0,
  fromKind: 'scratch',
  fromRefId: null,
  chaptersCount: 3,
  createdAt: new Date('2026-04-01T00:00:00Z'),
  updatedAt: new Date('2026-04-02T00:00:00Z'),
};

describe('KS-2885 B12 · StudyService.fromAnalysis', () => {
  let prisma: any;
  let svc: StudyService;
  let members: any;

  beforeEach(() => {
    prisma = makePrisma();
    members = { getRole: jest.fn(async () => null) };
    svc = new StudyService(
      prisma as unknown as PrismaService,
      makeSlug() as unknown as StudySlugService,
      members,
    );

    prisma.analysis.findUnique.mockResolvedValue(ownAnalysis);
    prisma.study.findUnique.mockResolvedValue(baseStudy);
    prisma.__tx.studyChapter.create.mockResolvedValue({ id: chapterId });
    prisma.__tx.study.create.mockResolvedValue({
      ...baseStudy,
      slug: 'analysis-slug-xyz',
    });
  });

  describe('XOR studyId / newStudyName', () => {
    it('400 если оба studyId и newStudyName переданы', async () => {
      await expect(
        svc.fromAnalysis(userId, {
          analysisId,
          studyId,
          newStudyName: 'X',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400 если ни studyId, ни newStudyName не переданы', async () => {
      await expect(
        svc.fromAnalysis(userId, { analysisId }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('Analysis access', () => {
    it('404 если analysis не существует', async () => {
      prisma.analysis.findUnique.mockResolvedValue(null);
      await expect(
        svc.fromAnalysis(userId, { analysisId, newStudyName: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404 если analysis приватный и не свой', async () => {
      prisma.analysis.findUnique.mockResolvedValue({
        ...ownAnalysis,
        userId: otherUserId,
        isPublic: false,
      });
      await expect(
        svc.fromAnalysis(userId, { analysisId, newStudyName: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('public analysis чужого пользователя — допускается', async () => {
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
  });

  describe('create new study (newStudyName)', () => {
    it('создаёт private-студию с fromKind=analysis:<id>, fromRefId=analysisId, chaptersCount=1', async () => {
      await svc.fromAnalysis(userId, {
        analysisId,
        newStudyName: 'Course chapter',
      });

      const studyData = prisma.__tx.study.create.mock.calls[0][0].data;
      expect(studyData).toMatchObject({
        ownerId: userId,
        name: 'Course chapter',
        visibility: 'private',
        isPublic: false,
        fromKind: `analysis:${analysisId}`,
        fromRefId: analysisId,
        chaptersCount: 1,
      });
    });

    it('создаёт owner-record в study_members в той же транзакции', async () => {
      await svc.fromAnalysis(userId, {
        analysisId,
        newStudyName: 'X',
      });
      expect(prisma.__tx.studyMember.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId, role: 'owner' }),
      });
    });

    it('первая глава: orderIdx=STUDY_ORDER_STEP, pgn копируется, mode=analysis', async () => {
      await svc.fromAnalysis(userId, {
        analysisId,
        newStudyName: 'X',
      });
      const chapterData =
        prisma.__tx.studyChapter.create.mock.calls[0][0].data;
      expect(chapterData.orderIdx).toBe(STUDY_ORDER_STEP);
      expect(chapterData.pgn).toBe('1. e4 e5 2. Nf3 *');
      expect(chapterData.mode).toBe('analysis');
      expect(chapterData.startFen).toBe(ownAnalysis.fen);
    });

    it('имя главы fallback `Analysis from <YYYY-MM-DD>` при пустом title', async () => {
      prisma.analysis.findUnique.mockResolvedValue({
        ...ownAnalysis,
        title: '',
      });
      await svc.fromAnalysis(userId, {
        analysisId,
        newStudyName: 'X',
      });
      const chapterData =
        prisma.__tx.studyChapter.create.mock.calls[0][0].data;
      expect(chapterData.name).toBe('Analysis from 2026-05-10');
    });

    it('400 при превышении лимита studiesPerUser', async () => {
      prisma.study.count.mockResolvedValue(STUDY_LIMITS.studiesPerUser);
      await expect(
        svc.fromAnalysis(userId, { analysisId, newStudyName: 'X' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.__tx.study.create).not.toHaveBeenCalled();
    });

    it('response = {studyId, slug, chapterId}', async () => {
      const r = await svc.fromAnalysis(userId, {
        analysisId,
        newStudyName: 'X',
      });
      expect(r).toEqual({
        studyId: baseStudy.id,
        slug: 'analysis-slug-xyz',
        chapterId,
      });
    });
  });

  describe('add to existing (studyId)', () => {
    it('owner: добавляет главу, orderIdx = max + STUDY_ORDER_STEP', async () => {
      prisma.studyChapter.findFirst.mockResolvedValue({ orderIdx: 5000 });

      await svc.fromAnalysis(userId, { analysisId, studyId });

      const chapterData =
        prisma.__tx.studyChapter.create.mock.calls[0][0].data;
      expect(chapterData.studyId).toBe(studyId);
      expect(chapterData.orderIdx).toBe(5000 + STUDY_ORDER_STEP);

      // chaptersCount у студии инкрементируется
      expect(prisma.__tx.study.update).toHaveBeenCalledWith({
        where: { id: studyId },
        data: { chaptersCount: { increment: 1 } },
      });
    });

    it('первая глава в пустой студии → orderIdx = STUDY_ORDER_STEP', async () => {
      prisma.studyChapter.findFirst.mockResolvedValue(null); // ни одной главы
      await svc.fromAnalysis(userId, { analysisId, studyId });
      const chapterData =
        prisma.__tx.studyChapter.create.mock.calls[0][0].data;
      expect(chapterData.orderIdx).toBe(STUDY_ORDER_STEP);
    });

    it('contributor (не owner) — допускается', async () => {
      prisma.study.findUnique.mockResolvedValue({
        ...baseStudy,
        ownerId: otherUserId, // студия чужая
      });
      members.getRole.mockResolvedValueOnce('contributor');

      const r = await svc.fromAnalysis(userId, { analysisId, studyId });
      expect(r.chapterId).toBe(chapterId);
    });

    it('outsider (роли нет) → 404 (не светим существование студии)', async () => {
      prisma.study.findUnique.mockResolvedValue({
        ...baseStudy,
        ownerId: otherUserId,
      });
      members.getRole.mockResolvedValueOnce(null);

      await expect(
        svc.fromAnalysis(userId, { analysisId, studyId }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('spectator (role=spectator) → 404', async () => {
      prisma.study.findUnique.mockResolvedValue({
        ...baseStudy,
        ownerId: otherUserId,
      });
      members.getRole.mockResolvedValueOnce('spectator');

      await expect(
        svc.fromAnalysis(userId, { analysisId, studyId }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404 если studyId не найден', async () => {
      prisma.study.findUnique.mockResolvedValue(null);
      await expect(
        svc.fromAnalysis(userId, { analysisId, studyId }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('лимит 64 глав на студию (STUDY_LIMITS.chaptersPerStudy)', () => {
    it('64 главы → 400 BadRequestException + create НЕ вызывается', async () => {
      prisma.studyChapter.count.mockResolvedValue(
        STUDY_LIMITS.chaptersPerStudy,
      );
      await expect(
        svc.fromAnalysis(userId, { analysisId, studyId }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.__tx.studyChapter.create).not.toHaveBeenCalled();
    });

    it('63 главы → проходит (граница ровно <64)', async () => {
      prisma.studyChapter.count.mockResolvedValue(
        STUDY_LIMITS.chaptersPerStudy - 1,
      );
      const r = await svc.fromAnalysis(userId, { analysisId, studyId });
      expect(r.chapterId).toBe(chapterId);
    });

    it('лимит проверяется ДО транзакции (insert-attempt не делается)', async () => {
      prisma.studyChapter.count.mockResolvedValue(
        STUDY_LIMITS.chaptersPerStudy + 10,
      );
      await expect(
        svc.fromAnalysis(userId, { analysisId, studyId }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
