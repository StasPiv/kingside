import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { LessonsAdminService } from './lessons-admin.service';

describe('LessonsAdminService — courses (KS-1967)', () => {
  let prisma: any;
  let service: LessonsAdminService;

  beforeEach(() => {
    prisma = {
      course: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _max: { order: null } }),
      },
      $transaction: jest.fn(async (ops: any) => Promise.all(ops)),
    };
    service = new LessonsAdminService(prisma);
  });

  // ─── list ──────────────────────────────────────────────────────────

  describe('listCourses', () => {
    it('без фильтров — без where', async () => {
      await service.listCourses({});
      expect(prisma.course.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {},
          orderBy: [{ level: 'asc' }, { order: 'asc' }],
          include: { _count: { select: { lessons: true } } },
        }),
      );
    });

    it('фильтр по level', async () => {
      await service.listCourses({ level: 'intermediate' });
      expect(prisma.course.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { level: 'intermediate' } }),
      );
    });

    it('фильтр по published', async () => {
      await service.listCourses({ published: true });
      expect(prisma.course.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isPublished: true } }),
      );
    });

    it('фильтр по published=false (drafts)', async () => {
      await service.listCourses({ published: false });
      expect(prisma.course.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isPublished: false } }),
      );
    });
  });

  // ─── getById ───────────────────────────────────────────────────────

  describe('getCourseById', () => {
    it('найден → возвращает с уроками и счётчиками', async () => {
      const row = { id: 'c1', slug: 's', lessons: [], _count: { lessons: 0 } };
      prisma.course.findUnique.mockResolvedValue(row);
      await expect(service.getCourseById('c1')).resolves.toBe(row);
      expect(prisma.course.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'c1' },
          include: expect.objectContaining({
            lessons: expect.any(Object),
            _count: { select: { lessons: true } },
          }),
        }),
      );
    });

    it('не найден → 404', async () => {
      prisma.course.findUnique.mockResolvedValue(null);
      await expect(service.getCourseById('nope')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── create ────────────────────────────────────────────────────────

  describe('createCourse', () => {
    it('order не передан — берётся max(order)+1', async () => {
      prisma.course.aggregate.mockResolvedValue({ _max: { order: 4 } });
      prisma.course.create.mockImplementation(({ data }: any) => ({ id: 'new', ...data }));

      const dto = {
        slug: 'beginner',
        level: 'beginner' as const,
        titleKey: 'k.title',
        descriptionKey: 'k.desc',
      };
      const r = await service.createCourse(dto as any);

      expect(prisma.course.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          slug: 'beginner',
          level: 'beginner',
          titleKey: 'k.title',
          descriptionKey: 'k.desc',
          order: 5,
          difficulty: 2, // default
          tags: [],
          isPublished: false,
        }),
      });
      expect(r.order).toBe(5);
    });

    it('первый курс (max=null) → order=0', async () => {
      prisma.course.aggregate.mockResolvedValue({ _max: { order: null } });
      prisma.course.create.mockImplementation(({ data }: any) => ({ id: 'new', ...data }));

      await service.createCourse({
        slug: 's', level: 'beginner', titleKey: 'k', descriptionKey: 'd',
      } as any);

      expect(prisma.course.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ order: 0 }),
      });
    });

    it('явный order не перезаписывается', async () => {
      prisma.course.create.mockImplementation(({ data }: any) => ({ id: 'new', ...data }));
      await service.createCourse({
        slug: 's', level: 'beginner', titleKey: 'k', descriptionKey: 'd', order: 99,
      } as any);
      expect(prisma.course.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ order: 99 }) }),
      );
    });

    it('inline + i18n + карточные поля прокидываются 1-в-1', async () => {
      prisma.course.create.mockImplementation(({ data }: any) => ({ id: 'new', ...data }));
      await service.createCourse({
        slug: 's', level: 'advanced', titleKey: 'tk', descriptionKey: 'dk',
        title: 'Inline', description: 'Inline desc',
        audience: 'Adv', hook: 'Hook', outcome: 'Out',
        audienceI18nKey: 'a.k', hookI18nKey: 'h.k', outcomeI18nKey: 'o.k',
        coverUrl: 'https://x/y.png', difficulty: 3, estimatedMinutes: 120,
        tags: ['endgame', 'tactics'], order: 1, isPublished: true,
      } as any);
      expect(prisma.course.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          title: 'Inline', description: 'Inline desc',
          audience: 'Adv', hook: 'Hook', outcome: 'Out',
          audienceI18nKey: 'a.k', hookI18nKey: 'h.k', outcomeI18nKey: 'o.k',
          coverUrl: 'https://x/y.png', difficulty: 3, estimatedMinutes: 120,
          tags: ['endgame', 'tactics'], order: 1, isPublished: true,
        }),
      });
    });

    it('конфликт slug (P2002) → 409', async () => {
      prisma.course.create.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.createCourse({ slug: 'dup', level: 'beginner', titleKey: 'k', descriptionKey: 'd' } as any),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ─── update ────────────────────────────────────────────────────────

  describe('updateCourse', () => {
    it('курс не найден → 404 (без update)', async () => {
      prisma.course.findUnique.mockResolvedValue(null);
      await expect(service.updateCourse('x', { title: 't' } as any)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.course.update).not.toHaveBeenCalled();
    });

    it('обновляет только переданные поля; null допускается для nullable', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.course.update.mockImplementation(({ data }: any) => ({ id: 'c1', ...data }));
      await service.updateCourse('c1', {
        title: 'New',
        audience: null, // явное обнуление
      } as any);
      const call = prisma.course.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'c1' });
      expect(call.data).toEqual({ title: 'New', audience: null });
    });

    it('конфликт slug → 409', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.course.update.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.updateCourse('c1', { slug: 'dup' } as any),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ─── delete ────────────────────────────────────────────────────────

  describe('deleteCourse', () => {
    it('не найден → 404', async () => {
      prisma.course.findUnique.mockResolvedValue(null);
      await expect(service.deleteCourse('x')).rejects.toThrow(NotFoundException);
      expect(prisma.course.delete).not.toHaveBeenCalled();
    });

    it('найден → delete (cascade ложится на БД)', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.course.delete.mockResolvedValue({ id: 'c1' });
      await service.deleteCourse('c1');
      expect(prisma.course.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
    });
  });

  // ─── reorder ───────────────────────────────────────────────────────

  describe('reorderCourses', () => {
    it('ids неполные → 400', async () => {
      prisma.course.count.mockResolvedValue(3);
      await expect(
        service.reorderCourses({ ids: ['a', 'b'] } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('id не существует → 400', async () => {
      prisma.course.count.mockResolvedValue(2);
      prisma.course.findMany.mockResolvedValue([{ id: 'a' }]); // нашли только 1 из 2
      await expect(
        service.reorderCourses({ ids: ['a', 'ghost'] } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('happy path — транзакционно обновляет order 0..N-1', async () => {
      prisma.course.count.mockResolvedValue(3);
      prisma.course.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      prisma.course.update.mockResolvedValue({});

      await service.reorderCourses({ ids: ['c', 'a', 'b'] } as any);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // Проверяем, что update вызвался по 3 раза с правильными order'ами.
      const calls = prisma.course.update.mock.calls;
      expect(calls).toHaveLength(3);
      expect(calls[0][0]).toEqual({ where: { id: 'c' }, data: { order: 0 } });
      expect(calls[1][0]).toEqual({ where: { id: 'a' }, data: { order: 1 } });
      expect(calls[2][0]).toEqual({ where: { id: 'b' }, data: { order: 2 } });
    });
  });
});
