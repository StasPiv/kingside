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
      lesson: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _max: { order: null } }),
      },
      lessonStep: {
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
    // KS-3180: gameStepHydrator используется при создании/обновлении
    // шага типа `game`. Для остальных тестов hydrate должен быть
    // no-op — возвращаем payload как есть.
    const gameStepHydrator = {
      hydrate: jest.fn(async (payload: any) => payload),
    } as any;
    service = new LessonsAdminService(prisma, gameStepHydrator);
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

  // ═══ Lessons (KS-1968 / B-6) ═══════════════════════════════════════

  describe('createLesson', () => {
    const courseId = 'course-1';
    const baseDto = {
      slug: 'intro',
      blockKey: 'rules',
      kind: 'theory' as const,
      titleKey: 'l.title',
      summaryKey: 'l.summary',
    };

    it('курс не найден → 404 (без create)', async () => {
      prisma.course.findUnique.mockResolvedValue(null);
      await expect(service.createLesson(courseId, baseDto as any)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.lesson.create).not.toHaveBeenCalled();
    });

    it('order не передан — max(order)+1 в рамках курса', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: courseId });
      prisma.lesson.aggregate.mockResolvedValue({ _max: { order: 7 } });
      prisma.lesson.create.mockImplementation(({ data }: any) => ({ id: 'L1', ...data }));

      await service.createLesson(courseId, baseDto as any);

      expect(prisma.lesson.aggregate).toHaveBeenCalledWith({
        where: { courseId },
        _max: { order: true },
      });
      expect(prisma.lesson.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          courseId,
          slug: 'intro',
          blockKey: 'rules',
          kind: 'theory',
          order: 8,
          estMinutes: 10,
          isPublished: false,
        }),
      });
    });

    it('первый урок (max=null) → order=0', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: courseId });
      prisma.lesson.aggregate.mockResolvedValue({ _max: { order: null } });
      prisma.lesson.create.mockImplementation(({ data }: any) => ({ id: 'L1', ...data }));

      await service.createLesson(courseId, baseDto as any);

      expect(prisma.lesson.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ order: 0 }),
      });
    });

    it('inline title/summary прокидываются 1-в-1', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: courseId });
      prisma.lesson.aggregate.mockResolvedValue({ _max: { order: null } });
      prisma.lesson.create.mockImplementation(({ data }: any) => ({ id: 'L1', ...data }));

      await service.createLesson(courseId, {
        ...baseDto,
        title: 'Урок 1',
        summary: 'Краткий конспект',
        estMinutes: 25,
        isPublished: true,
      } as any);

      expect(prisma.lesson.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          title: 'Урок 1',
          summary: 'Краткий конспект',
          estMinutes: 25,
          isPublished: true,
        }),
      });
    });

    it('конфликт slug в курсе (P2002) → 409', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: courseId });
      prisma.lesson.aggregate.mockResolvedValue({ _max: { order: null } });
      prisma.lesson.create.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.createLesson(courseId, baseDto as any),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('getLessonById', () => {
    it('найден → возвращает с шагами', async () => {
      const row = { id: 'L1', steps: [], _count: { steps: 0 } };
      prisma.lesson.findUnique.mockResolvedValue(row);
      await expect(service.getLessonById('L1')).resolves.toBe(row);
      expect(prisma.lesson.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'L1' },
          include: expect.objectContaining({
            steps: { orderBy: { order: 'asc' } },
            _count: { select: { steps: true } },
          }),
        }),
      );
    });

    it('не найден → 404', async () => {
      prisma.lesson.findUnique.mockResolvedValue(null);
      await expect(service.getLessonById('nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateLesson', () => {
    it('не найден → 404 (без update)', async () => {
      prisma.lesson.findUnique.mockResolvedValue(null);
      await expect(service.updateLesson('x', { title: 't' } as any)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.lesson.update).not.toHaveBeenCalled();
    });

    it('обновляет только переданные поля; null допускается для inline', async () => {
      prisma.lesson.findUnique.mockResolvedValue({ id: 'L1' });
      prisma.lesson.update.mockImplementation(({ data }: any) => ({ id: 'L1', ...data }));

      await service.updateLesson('L1', {
        title: 'New title',
        summary: null,
      } as any);

      const call = prisma.lesson.update.mock.calls[0][0];
      expect(call).toEqual({ where: { id: 'L1' }, data: { title: 'New title', summary: null } });
    });

    it('конфликт slug → 409', async () => {
      prisma.lesson.findUnique.mockResolvedValue({ id: 'L1' });
      prisma.lesson.update.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.updateLesson('L1', { slug: 'dup' } as any),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('deleteLesson', () => {
    it('не найден → 404', async () => {
      prisma.lesson.findUnique.mockResolvedValue(null);
      await expect(service.deleteLesson('x')).rejects.toThrow(NotFoundException);
      expect(prisma.lesson.delete).not.toHaveBeenCalled();
    });

    it('найден → delete (cascade в БД)', async () => {
      prisma.lesson.findUnique.mockResolvedValue({ id: 'L1' });
      prisma.lesson.delete.mockResolvedValue({ id: 'L1' });
      await service.deleteLesson('L1');
      expect(prisma.lesson.delete).toHaveBeenCalledWith({ where: { id: 'L1' } });
    });
  });

  describe('reorderLessons', () => {
    const courseId = 'course-1';

    it('курс не найден → 404', async () => {
      prisma.course.findUnique.mockResolvedValue(null);
      await expect(
        service.reorderLessons(courseId, { ids: ['a'] } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('ids неполные → 400', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: courseId });
      prisma.lesson.count.mockResolvedValue(3);
      await expect(
        service.reorderLessons(courseId, { ids: ['a', 'b'] } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('id из чужого курса → 400 (фильтр по courseId не нашёл)', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: courseId });
      prisma.lesson.count.mockResolvedValue(2);
      // Только 1 из 2 принадлежит этому курсу.
      prisma.lesson.findMany.mockResolvedValue([{ id: 'a' }]);
      await expect(
        service.reorderLessons(courseId, { ids: ['a', 'foreign'] } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('happy path — транзакционно перезаписывает order 0..N-1', async () => {
      prisma.course.findUnique.mockResolvedValue({ id: courseId });
      prisma.lesson.count.mockResolvedValue(3);
      prisma.lesson.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      prisma.lesson.update.mockResolvedValue({});

      await service.reorderLessons(courseId, { ids: ['c', 'a', 'b'] } as any);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const calls = prisma.lesson.update.mock.calls;
      expect(calls).toHaveLength(3);
      expect(calls[0][0]).toEqual({ where: { id: 'c' }, data: { order: 0 } });
      expect(calls[1][0]).toEqual({ where: { id: 'a' }, data: { order: 1 } });
      expect(calls[2][0]).toEqual({ where: { id: 'b' }, data: { order: 2 } });
    });
  });

  // ═══ Steps (KS-1969 / B-7) ═════════════════════════════════════════

  describe('createStep', () => {
    const lessonId = 'lesson-1';
    const textPayload = { type: 'text' as const, bodyMarkdown: '# Hi' };

    it('урок не найден → 404', async () => {
      prisma.lesson.findUnique.mockResolvedValue(null);
      await expect(
        service.createStep(lessonId, { type: 'text', payload: textPayload } as any),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.lessonStep.create).not.toHaveBeenCalled();
    });

    it('type не совпадает с payload.type → 400', async () => {
      prisma.lesson.findUnique.mockResolvedValue({ id: lessonId });
      await expect(
        service.createStep(lessonId, {
          type: 'puzzle',
          payload: textPayload,
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.lessonStep.create).not.toHaveBeenCalled();
    });

    it('order не передан → max(order)+1 в рамках урока', async () => {
      prisma.lesson.findUnique.mockResolvedValue({ id: lessonId });
      prisma.lessonStep.aggregate.mockResolvedValue({ _max: { order: 4 } });
      prisma.lessonStep.create.mockImplementation(({ data }: any) => ({ id: 'S1', ...data }));

      await service.createStep(lessonId, {
        type: 'text',
        payload: textPayload,
      } as any);

      expect(prisma.lessonStep.aggregate).toHaveBeenCalledWith({
        where: { lessonId },
        _max: { order: true },
      });
      expect(prisma.lessonStep.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          lessonId,
          order: 5,
          type: 'text',
          payload: textPayload,
        }),
      });
    });

    it('первый шаг (max=null) → order=0; явный order не перезаписывается', async () => {
      prisma.lesson.findUnique.mockResolvedValue({ id: lessonId });
      prisma.lessonStep.aggregate.mockResolvedValue({ _max: { order: null } });
      prisma.lessonStep.create.mockImplementation(({ data }: any) => ({ id: 'S1', ...data }));

      await service.createStep(lessonId, {
        type: 'text', payload: textPayload, order: 12,
      } as any);

      expect(prisma.lessonStep.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ order: 12 }),
      });
    });
  });

  describe('updateStep', () => {
    it('не найден → 404', async () => {
      prisma.lessonStep.findUnique.mockResolvedValue(null);
      await expect(service.updateStep('x', { order: 1 } as any)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.lessonStep.update).not.toHaveBeenCalled();
    });

    it('смена type без payload → 400', async () => {
      prisma.lessonStep.findUnique.mockResolvedValue({ id: 'S1', type: 'text' });
      await expect(
        service.updateStep('S1', { type: 'quiz' } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('type меняется и payload передан, но они не совпадают → 400', async () => {
      prisma.lessonStep.findUnique.mockResolvedValue({ id: 'S1', type: 'text' });
      await expect(
        service.updateStep('S1', {
          type: 'quiz',
          payload: { type: 'text', bodyMarkdown: 'x' },
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('изменение только order — корректный update', async () => {
      prisma.lessonStep.findUnique.mockResolvedValue({ id: 'S1', type: 'text' });
      prisma.lessonStep.update.mockImplementation(({ data }: any) => ({ id: 'S1', ...data }));
      await service.updateStep('S1', { order: 7 } as any);
      expect(prisma.lessonStep.update).toHaveBeenCalledWith({
        where: { id: 'S1' }, data: { order: 7 },
      });
    });

    it('смена type с правильным payload — type+payload идут в update', async () => {
      prisma.lessonStep.findUnique.mockResolvedValue({ id: 'S1', type: 'text' });
      prisma.lessonStep.update.mockImplementation(({ data }: any) => ({ id: 'S1', ...data }));
      const newPayload = { type: 'quiz', questions: [], passThreshold: 0.7 };
      await service.updateStep('S1', { type: 'quiz', payload: newPayload } as any);
      expect(prisma.lessonStep.update).toHaveBeenCalledWith({
        where: { id: 'S1' },
        data: { type: 'quiz', payload: newPayload },
      });
    });
  });

  describe('deleteStep', () => {
    it('не найден → 404', async () => {
      prisma.lessonStep.findUnique.mockResolvedValue(null);
      await expect(service.deleteStep('x')).rejects.toThrow(NotFoundException);
      expect(prisma.lessonStep.delete).not.toHaveBeenCalled();
    });

    it('найден → delete', async () => {
      prisma.lessonStep.findUnique.mockResolvedValue({ id: 'S1' });
      prisma.lessonStep.delete.mockResolvedValue({ id: 'S1' });
      await service.deleteStep('S1');
      expect(prisma.lessonStep.delete).toHaveBeenCalledWith({ where: { id: 'S1' } });
    });
  });

  describe('reorderSteps', () => {
    const lessonId = 'lesson-1';

    it('урок не найден → 404', async () => {
      prisma.lesson.findUnique.mockResolvedValue(null);
      await expect(
        service.reorderSteps(lessonId, { ids: ['a'] } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('ids неполные → 400', async () => {
      prisma.lesson.findUnique.mockResolvedValue({ id: lessonId });
      prisma.lessonStep.count.mockResolvedValue(3);
      await expect(
        service.reorderSteps(lessonId, { ids: ['a', 'b'] } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('id из чужого урока → 400', async () => {
      prisma.lesson.findUnique.mockResolvedValue({ id: lessonId });
      prisma.lessonStep.count.mockResolvedValue(2);
      prisma.lessonStep.findMany.mockResolvedValue([{ id: 'a' }]);
      await expect(
        service.reorderSteps(lessonId, { ids: ['a', 'foreign'] } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('happy path — транзакционно перезаписывает order 0..N-1', async () => {
      prisma.lesson.findUnique.mockResolvedValue({ id: lessonId });
      prisma.lessonStep.count.mockResolvedValue(3);
      prisma.lessonStep.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      prisma.lessonStep.update.mockResolvedValue({});

      await service.reorderSteps(lessonId, { ids: ['c', 'a', 'b'] } as any);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const calls = prisma.lessonStep.update.mock.calls;
      expect(calls).toHaveLength(3);
      expect(calls[0][0]).toEqual({ where: { id: 'c' }, data: { order: 0 } });
      expect(calls[1][0]).toEqual({ where: { id: 'a' }, data: { order: 1 } });
      expect(calls[2][0]).toEqual({ where: { id: 'b' }, data: { order: 2 } });
    });
  });
});
