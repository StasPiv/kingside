import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserCoursesService } from './user-courses.service';

describe('UserCoursesService (KS-1829)', () => {
  let service: UserCoursesService;
  let prisma: any;
  let slug: { generateUnique: jest.Mock; validateExplicit: jest.Mock };

  const OWNER = 'owner-1';

  beforeEach(() => {
    slug = {
      generateUnique: jest.fn().mockResolvedValue('abc123-generated'),
      validateExplicit: jest.fn((s: string) => s),
    };
    prisma = {
      userCourse: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      userLesson: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      userCoursePlayProgress: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn((cb) =>
        cb({
          userLesson: prisma.userLesson,
        }),
      ),
    };
    service = new UserCoursesService(prisma, slug as any);
  });

  // ─── list ──────────────────────────────────────────────────────────

  describe('list', () => {
    it('mine=true → фильтр ownerId', async () => {
      prisma.userCourse.findMany.mockResolvedValue([]);
      await service.list(OWNER, { mine: true });
      expect(prisma.userCourse.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ownerId: OWNER } }),
      );
    });

    it('mine=false → фильтр isPublic', async () => {
      prisma.userCourse.findMany.mockResolvedValue([]);
      await service.list(OWNER, { mine: false });
      expect(prisma.userCourse.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isPublic: true } }),
      );
    });

    it('мапит lessonCount из _count', async () => {
      prisma.userCourse.findMany.mockResolvedValue([
        {
          id: 'c1',
          ownerId: OWNER,
          slug: 'a-b',
          title: 'Course',
          description: null,
          isPublic: false,
          createdAt: new Date('2026-04-01'),
          updatedAt: new Date('2026-04-02'),
          _count: { lessons: 3 },
        },
      ]);
      const r = await service.list(OWNER, { mine: true });
      expect(r.data[0].lessonCount).toBe(3);
    });
  });

  // ─── getBySlug ─────────────────────────────────────────────────────

  describe('getBySlug', () => {
    it('возвращает курс, уроки и прогресс', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({
        id: 'c1',
        ownerId: OWNER,
        slug: 's',
        title: 't',
        description: null,
        isPublic: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { lessons: 1 },
        lessons: [
          {
            id: 'l1',
            userCourseId: 'c1',
            order: 0,
            title: 'L',
            estMinutes: null,
            _count: { steps: 2 },
          },
        ],
      });
      prisma.userCoursePlayProgress.findUnique.mockResolvedValue({
        userCourseId: 'c1',
        completedLessonsCount: 1,
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: null,
      });

      const r = await service.getBySlug(OWNER, 's');
      expect(r.course.id).toBe('c1');
      expect(r.lessons).toHaveLength(1);
      expect(r.progress?.completedLessonsCount).toBe(1);
    });

    it('курс не найден → 404', async () => {
      prisma.userCourse.findUnique.mockResolvedValue(null);
      await expect(service.getBySlug(OWNER, 'nope')).rejects.toThrow(NotFoundException);
    });

    it('прогресс = null, если пользователь ещё не начинал', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({
        id: 'c1',
        ownerId: OWNER,
        slug: 's',
        title: 't',
        description: null,
        isPublic: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { lessons: 0 },
        lessons: [],
      });
      prisma.userCoursePlayProgress.findUnique.mockResolvedValue(null);
      const r = await service.getBySlug(OWNER, 's');
      expect(r.progress).toBeNull();
    });
  });

  // ─── create ────────────────────────────────────────────────────────

  describe('create', () => {
    it('создаёт курс со slug из title и ownerId из параметра', async () => {
      prisma.userCourse.create.mockImplementation(async ({ data }: any) => ({
        id: 'c1',
        ...data,
        description: data.description ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { lessons: 0 },
      }));
      const r = await service.create(OWNER, { title: 'Мой курс' });
      expect(prisma.userCourse.create).toHaveBeenCalled();
      const call = prisma.userCourse.create.mock.calls[0][0];
      expect(call.data.ownerId).toBe(OWNER);
      expect(call.data.title).toBe('Мой курс');
      // slug пришёл из SlugService.generateUnique (замок выше).
      expect(call.data.slug).toBe('abc123-generated');
      expect(slug.generateUnique).toHaveBeenCalledWith('Мой курс');
      expect(r.ownerId).toBe(OWNER);
    });

    it('пустой title → 400 (до вызова SlugService)', async () => {
      await expect(service.create(OWNER, { title: '   ' } as any)).rejects.toThrow(
        BadRequestException,
      );
      expect(slug.generateUnique).not.toHaveBeenCalled();
    });

    it('явный slug идёт через validateExplicit, не через generateUnique', async () => {
      prisma.userCourse.create.mockImplementation(async ({ data }: any) => ({
        id: 'c1', ...data, description: data.description ?? null,
        createdAt: new Date(), updatedAt: new Date(), _count: { lessons: 0 },
      }));
      await service.create(OWNER, { title: 'Hi', slug: 'my-nice-slug' });
      expect(slug.validateExplicit).toHaveBeenCalledWith('my-nice-slug');
      expect(slug.generateUnique).not.toHaveBeenCalled();
    });

    it('slug-коллизия (P2002) для авто → 400 "slug collision, retry"', async () => {
      prisma.userCourse.create.mockRejectedValue({ code: 'P2002' });
      await expect(service.create(OWNER, { title: 'Hi' })).rejects.toMatchObject({
        message: expect.stringContaining('slug collision'),
      });
    });

    it('slug-коллизия (P2002) при явном slug → 400 "slug already taken"', async () => {
      prisma.userCourse.create.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.create(OWNER, { title: 'Hi', slug: 'taken-one' }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('already taken'),
      });
    });
  });

  // ─── update / delete ownership enforcement ────────────────────────

  describe('update/delete', () => {
    it('update чужого курса → 403', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      await expect(
        service.update(OWNER, 'c1', { title: 'new' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('delete чужого курса → 403', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      await expect(service.delete(OWNER, 'c1')).rejects.toThrow(ForbiddenException);
    });

    it('update несуществующего курса → 404', async () => {
      prisma.userCourse.findUnique.mockResolvedValue(null);
      await expect(service.update(OWNER, 'c1', {})).rejects.toThrow(NotFoundException);
    });
  });

  // ─── addLesson ─────────────────────────────────────────────────────

  describe('addLesson', () => {
    it('первый урок получает order=0', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER });
      prisma.userLesson.findFirst.mockResolvedValue(null);
      prisma.userLesson.create.mockImplementation(async ({ data }: any) => ({
        id: 'l1',
        ...data,
        estMinutes: data.estMinutes ?? null,
        _count: { steps: 0 },
      }));
      const r = await service.addLesson(OWNER, 'c1', { title: 'L' });
      expect(prisma.userLesson.create.mock.calls[0][0].data.order).toBe(0);
      expect(r.order).toBe(0);
    });

    it('следующий урок — order = max+1', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER });
      prisma.userLesson.findFirst.mockResolvedValue({ order: 4 });
      prisma.userLesson.create.mockImplementation(async ({ data }: any) => ({
        id: 'l1',
        ...data,
        estMinutes: data.estMinutes ?? null,
        _count: { steps: 0 },
      }));
      const r = await service.addLesson(OWNER, 'c1', { title: 'L' });
      expect(r.order).toBe(5);
    });

    it('пустой title → 400', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER });
      await expect(
        service.addLesson(OWNER, 'c1', { title: '' } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

});
