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
  // KS-2857: Phase 2 поля (ADR-060 §3.2).
  visibility: 'private',
  topics: [],
  likes: 0,
  fromKind: 'scratch',
  fromRefId: null,
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

  describe('importPgn — KS-2820 T5', () => {
    const multiPgn = `[Event "Game 1"]
[White "A"]
[Black "B"]
1. e4 e5 *

[Event "Game 2"]
[White "C"]
[Black "D"]
1. d4 d5 *`;

    it('режет multi-PGN на главы и инкрементит chaptersCount', async () => {
      prisma.studyChapter.count.mockResolvedValue(0);
      prisma.studyChapter.findFirst.mockResolvedValue(null);
      let cnt = 0;
      tx.studyChapter.create.mockImplementation(async (args: any) => ({
        id: `ch${++cnt}`,
        studyId: study.id,
        name: args.data.name,
        orderIdx: args.data.orderIdx,
        pgn: args.data.pgn,
        startFen: args.data.startFen ?? null,
        orientation: 'white',
        mode: 'analysis',
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      const r = await svc.importPgn(study, multiPgn);
      expect(r.created).toHaveLength(2);
      expect(r.created[0].name).toBe('Game 1');
      expect(r.created[1].name).toBe('Game 2');
      // chaptersCount увеличивается на 2 (chunk единый).
      expect(tx.study.update).toHaveBeenCalledWith({
        where: { id: study.id },
        data: { chaptersCount: { increment: 2 } },
      });
    });

    it('400 если import переполнил бы chaptersPerStudy', async () => {
      prisma.studyChapter.count.mockResolvedValue(
        STUDY_LIMITS.chaptersPerStudy - 1,
      );
      await expect(svc.importPgn(study, multiPgn)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.studyChapter.create).not.toHaveBeenCalled();
    });

    it('400 если PGN пустой', async () => {
      await expect(svc.importPgn(study, '   \n  ')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('export — KS-2820 T5', () => {
    it('exportStudyPgn склеивает главы через \\n\\n', async () => {
      prisma.studyChapter.findMany.mockResolvedValue([
        { ...chapter, id: 'a', pgn: '[Event "A"]\n1. e4 *', orderIdx: 1000 },
        { ...chapter, id: 'b', pgn: '[Event "B"]\n1. d4 *', orderIdx: 2000 },
      ]);
      const pgn = await svc.exportStudyPgn(study);
      expect(pgn).toContain('[Event "A"]');
      expect(pgn).toContain('[Event "B"]');
      expect(pgn).toContain('\n\n');
    });

    it('exportStudyPgn добавляет [FEN] если есть startFen и не в pgn', async () => {
      prisma.studyChapter.findMany.mockResolvedValue([
        {
          ...chapter,
          startFen: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
          pgn: '1. Nf3 *',
        },
      ]);
      const pgn = await svc.exportStudyPgn(study);
      expect(pgn).toContain('[FEN "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"]');
      expect(pgn).toContain('[SetUp "1"]');
    });

    it('exportChapterPgn возвращает pgn одной главы', async () => {
      prisma.studyChapter.findUnique.mockResolvedValue(chapter);
      const pgn = await svc.exportChapterPgn(study, chapter.id);
      expect(pgn).toBe(chapter.pgn);
    });
  });

  describe('KS-2902: concealPly + gamebook сохраняются и возвращаются', () => {
    it('create: concealPly пробрасывается в data и в DTO', async () => {
      prisma.studyChapter.count.mockResolvedValue(0);
      prisma.studyChapter.findFirst.mockResolvedValue(null);
      tx.studyChapter.create.mockResolvedValue({
        ...chapter,
        mode: 'conceal',
        concealPly: 3,
      });
      const r = await svc.create(study, {
        name: 'C',
        mode: 'conceal',
        concealPly: 3,
      });
      const callData = tx.studyChapter.create.mock.calls[0][0].data;
      expect(callData.concealPly).toBe(3);
      expect(callData.mode).toBe('conceal');
      expect(r.concealPly).toBe(3);
    });

    it('create: gamebook payload валидируется и сохраняется', async () => {
      prisma.studyChapter.count.mockResolvedValue(0);
      prisma.studyChapter.findFirst.mockResolvedValue(null);
      const gamebook = {
        intro: 'Welcome',
        byUci: { e2e4: { hint: 'do it', success: 'good' } },
      };
      tx.studyChapter.create.mockResolvedValue({
        ...chapter,
        mode: 'gamebook',
        gamebook,
      });
      const r = await svc.create(study, {
        name: 'C',
        mode: 'gamebook',
        gamebook,
      });
      const callData = tx.studyChapter.create.mock.calls[0][0].data;
      expect(callData.gamebook).toEqual(gamebook);
      expect(r.gamebook).toEqual(gamebook);
    });

    it('create: без concealPly/gamebook → DbNull / null в DTO', async () => {
      prisma.studyChapter.count.mockResolvedValue(0);
      prisma.studyChapter.findFirst.mockResolvedValue(null);
      tx.studyChapter.create.mockResolvedValue(chapter);
      const r = await svc.create(study, { name: 'C' });
      const callData = tx.studyChapter.create.mock.calls[0][0].data;
      expect(callData.concealPly).toBeNull();
      // gamebook = Prisma.DbNull sentinel (в моке — 'DbNull' string).
      expect(callData.gamebook).toBeDefined();
      expect(r.concealPly).toBeNull();
      expect(r.gamebook).toBeNull();
    });

    it('update: concealPly явно null сбрасывает значение', async () => {
      prisma.studyChapter.findUnique.mockResolvedValue({
        ...chapter,
        concealPly: 5,
      });
      prisma.studyChapter.update.mockResolvedValue({
        ...chapter,
        concealPly: null,
      });
      const r = await svc.update(study, chapter.id, { concealPly: null });
      const callData = prisma.studyChapter.update.mock.calls[0][0].data;
      expect(callData).toHaveProperty('concealPly', null);
      expect(r.concealPly).toBeNull();
    });

    it('update: concealPly число применяется', async () => {
      prisma.studyChapter.findUnique.mockResolvedValue(chapter);
      prisma.studyChapter.update.mockResolvedValue({
        ...chapter,
        concealPly: 7,
      });
      const r = await svc.update(study, chapter.id, { concealPly: 7 });
      const callData = prisma.studyChapter.update.mock.calls[0][0].data;
      expect(callData.concealPly).toBe(7);
      expect(r.concealPly).toBe(7);
    });

    it('update: gamebook null → DbNull в data', async () => {
      prisma.studyChapter.findUnique.mockResolvedValue(chapter);
      prisma.studyChapter.update.mockResolvedValue({ ...chapter, gamebook: null });
      const r = await svc.update(study, chapter.id, { gamebook: null });
      const callData = prisma.studyChapter.update.mock.calls[0][0].data;
      expect(callData).toHaveProperty('gamebook');
      expect(r.gamebook).toBeNull();
    });

    it('update: gamebook валидный объект сохраняется', async () => {
      prisma.studyChapter.findUnique.mockResolvedValue(chapter);
      const gb = { intro: 'i', byUci: { d2d4: { success: 'ok' } } };
      prisma.studyChapter.update.mockResolvedValue({
        ...chapter,
        gamebook: gb,
      });
      const r = await svc.update(study, chapter.id, { gamebook: gb });
      const callData = prisma.studyChapter.update.mock.calls[0][0].data;
      expect(callData.gamebook).toEqual(gb);
      expect(r.gamebook).toEqual(gb);
    });

    it('update: gamebook с битым UCI ключом → 400', async () => {
      prisma.studyChapter.findUnique.mockResolvedValue(chapter);
      await expect(
        svc.update(study, chapter.id, {
          gamebook: { byUci: { xyz: { hint: 'x' } } },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.studyChapter.update).not.toHaveBeenCalled();
    });

    it('update: поля не передавались → не попадают в data (partial)', async () => {
      prisma.studyChapter.findUnique.mockResolvedValue(chapter);
      prisma.studyChapter.update.mockResolvedValue(chapter);
      await svc.update(study, chapter.id, { name: 'X' });
      const callData = prisma.studyChapter.update.mock.calls[0][0].data;
      expect(callData).not.toHaveProperty('concealPly');
      expect(callData).not.toHaveProperty('gamebook');
    });

    it('toChapterDto включает concealPly и gamebook', () => {
      // импорт через ESM — берём через require service-файла. Прямой
      // импорт делать в этом spec'е смысла нет: проверка идёт через
      // public API (create/update выше). Здесь — sanity-check, что
      // даже свежий chapter из БД c заполненными полями раскрывается
      // в DTO.
      prisma.studyChapter.findUnique.mockResolvedValue({
        ...chapter,
        concealPly: 4,
        gamebook: { intro: 'hi' },
      });
      // getById использует тот же toChapterDto.
      return svc.getById(study, chapter.id).then((r) => {
        expect(r.concealPly).toBe(4);
        expect(r.gamebook).toEqual({ intro: 'hi' });
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
