/**
 * KS-2815 / KS-2818 T3. Happy-path юнит-тесты `StudyChaptersService`.
 *
 * Import / export специфика покрывается дополнительно в KS-2820 (T5);
 * здесь — лимиты, базовый CRUD, reorder, pgn-size guard.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StudyChaptersService } from './study-chapters.service';
import { STUDY_LIMITS, STUDY_ORDER_STEP } from './study-limits';
import type { PrismaService } from '../prisma/prisma.service';

function makePrisma() {
  const txContext = {
    studyChapter: {
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn(),
    },
    study: {
      update: jest.fn(),
    },
  };
  const prisma = {
    studyChapter: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    study: {
      update: jest.fn(),
    },
    $transaction: jest.fn(
      async (cb: (tx: typeof txContext) => Promise<unknown>) => cb(txContext),
    ),
  };
  return { prisma, txContext } as unknown as {
    prisma: any;
    txContext: typeof txContext;
  };
}

const study = {
  id: 'study-id',
  ownerId: 'user-1',
  slug: 'abc-slug',
  name: 'S',
  description: null,
  isPublic: false,
  chaptersCount: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const chapter = {
  id: 'ch1',
  studyId: study.id,
  name: 'Chapter 1',
  orderIdx: 1000,
  pgn: '1. e4 *',
  startFen: null,
  orientation: 'white',
  mode: 'analysis',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('StudyChaptersService — KS-2818 T3', () => {
  let prisma: any;
  let tx: ReturnType<typeof makePrisma>['txContext'];
  let svc: StudyChaptersService;

  beforeEach(() => {
    const made = makePrisma();
    prisma = made.prisma;
    tx = made.txContext;
    svc = new StudyChaptersService(prisma);
  });

  describe('create', () => {
    it('создаёт главу и инкрементирует chaptersCount', async () => {
      prisma.studyChapter.count.mockResolvedValue(0);
      prisma.studyChapter.findFirst.mockResolvedValue(null); // нет глав
      tx.studyChapter.create.mockResolvedValue(chapter);
      const r = await svc.create(study, { name: 'Chapter 1' });
      expect(tx.studyChapter.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            studyId: study.id,
            name: 'Chapter 1',
            orderIdx: STUDY_ORDER_STEP,
            pgn: '',
            orientation: 'white',
            mode: 'analysis',
          }),
        }),
      );
      expect(tx.study.update).toHaveBeenCalledWith({
        where: { id: study.id },
        data: { chaptersCount: { increment: 1 } },
      });
      expect(r.id).toBe(chapter.id);
    });

    it('orderIdx = max(orderIdx) + 1000', async () => {
      prisma.studyChapter.count.mockResolvedValue(2);
      prisma.studyChapter.findFirst.mockResolvedValue({ orderIdx: 3000 });
      tx.studyChapter.create.mockResolvedValue({ ...chapter, orderIdx: 4000 });
      await svc.create(study, { name: 'New' });
      const callData = tx.studyChapter.create.mock.calls[0][0].data;
      expect(callData.orderIdx).toBe(4000);
    });

    it('400 при достижении лимита chaptersPerStudy', async () => {
      prisma.studyChapter.count.mockResolvedValue(
        STUDY_LIMITS.chaptersPerStudy,
      );
      await expect(svc.create(study, { name: 'X' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.studyChapter.create).not.toHaveBeenCalled();
    });

    it('400 если pgn больше лимита байтов', async () => {
      prisma.studyChapter.count.mockResolvedValue(0);
      const oversized = 'a'.repeat(STUDY_LIMITS.chapterPgnMaxBytes + 1);
      await expect(
        svc.create(study, { name: 'big', pgn: oversized }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update', () => {
    it('обновляет pgn существующей главы', async () => {
      prisma.studyChapter.findUnique.mockResolvedValue(chapter);
      prisma.studyChapter.update.mockResolvedValue({
        ...chapter,
        pgn: '1. d4 *',
      });
      const r = await svc.update(study, chapter.id, { pgn: '1. d4 *' });
      expect(prisma.studyChapter.update).toHaveBeenCalledWith({
        where: { id: chapter.id },
        data: { pgn: '1. d4 *' },
      });
      expect(r.pgn).toBe('1. d4 *');
    });

    it('404 если глава из другой студии', async () => {
      prisma.studyChapter.findUnique.mockResolvedValue({
        ...chapter,
        studyId: 'other-study',
      });
      await expect(
        svc.update(study, chapter.id, { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('400 если update.pgn больше лимита', async () => {
      prisma.studyChapter.findUnique.mockResolvedValue(chapter);
      const oversized = 'b'.repeat(STUDY_LIMITS.chapterPgnMaxBytes + 1);
      await expect(
        svc.update(study, chapter.id, { pgn: oversized }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('delete', () => {
    it('удаляет и декрементит chaptersCount', async () => {
      prisma.studyChapter.findUnique.mockResolvedValue(chapter);
      tx.studyChapter.delete.mockResolvedValue(chapter);
      await svc.delete(study, chapter.id);
      expect(tx.studyChapter.delete).toHaveBeenCalledWith({
        where: { id: chapter.id },
      });
      expect(tx.study.update).toHaveBeenCalledWith({
        where: { id: study.id },
        data: { chaptersCount: { decrement: 1 } },
      });
    });
  });

  describe('reorder', () => {
    const ch1 = { id: 'a', orderIdx: 1000 };
    const ch2 = { id: 'b', orderIdx: 2000 };
    const ch3 = { id: 'c', orderIdx: 3000 };

    it('after=null → ставит в начало (orderIdx = first - step)', async () => {
      prisma.studyChapter.findUnique.mockResolvedValue({
        ...chapter,
        id: 'c',
        orderIdx: 3000,
      });
      prisma.studyChapter.findMany.mockResolvedValue([ch1, ch2, ch3]);
      prisma.studyChapter.update.mockResolvedValue({
        ...chapter,
        id: 'c',
        orderIdx: 1000 - STUDY_ORDER_STEP,
      });
      const r = await svc.reorder(study, 'c', null);
      expect(prisma.studyChapter.update).toHaveBeenCalledWith({
        where: { id: 'c' },
        data: { orderIdx: 1000 - STUDY_ORDER_STEP },
      });
      expect(r.orderIdx).toBe(1000 - STUDY_ORDER_STEP);
    });

    it('after=B → среднее между B и C', async () => {
      prisma.studyChapter.findUnique.mockResolvedValue({
        ...chapter,
        id: 'a',
        orderIdx: 1000,
      });
      prisma.studyChapter.findMany.mockResolvedValue([ch1, ch2, ch3]);
      prisma.studyChapter.update.mockResolvedValue({
        ...chapter,
        id: 'a',
        orderIdx: 2500,
      });
      await svc.reorder(study, 'a', 'b');
      expect(prisma.studyChapter.update).toHaveBeenCalledWith({
        where: { id: 'a' },
        data: { orderIdx: 2500 },
      });
    });

    it('after=self → 400', async () => {
      prisma.studyChapter.findUnique.mockResolvedValue({
        ...chapter,
        id: 'a',
      });
      await expect(svc.reorder(study, 'a', 'a')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('after=несуществующий → 404', async () => {
      prisma.studyChapter.findUnique.mockResolvedValue({
        ...chapter,
        id: 'a',
      });
      prisma.studyChapter.findMany.mockResolvedValue([ch1]);
      await expect(
        svc.reorder(study, 'a', 'missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
