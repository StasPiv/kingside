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
        count: jest.fn().mockResolvedValue(0),
      },
      userLesson: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      userCoursePlayProgress: {
        findUnique: jest.fn(),
        // KS-1889: listEnrolled читает прогрессы с include(course).
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        // KS-1885: stats запрашиваются через count (single) и groupBy (list).
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn((cb) =>
        cb({
          userLesson: prisma.userLesson,
          userCoursePlayProgress: prisma.userCoursePlayProgress,
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

    // ─── KS-1885: stats в списке ────────────────────────────────
    describe('stats в списке (KS-1885)', () => {
      const ownedRow = (id: string) => ({
        id,
        ownerId: OWNER,
        slug: id,
        title: 't',
        description: null,
        isPublic: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { lessons: 0 },
      });

      it('mine=true: stats каждой карточки приходит из batched groupBy', async () => {
        prisma.userCourse.findMany.mockResolvedValue([
          ownedRow('c1'),
          ownedRow('c2'),
        ]);
        prisma.userCoursePlayProgress.groupBy
          .mockResolvedValueOnce([
            { userCourseId: 'c1', _count: { userCourseId: 4 } },
            { userCourseId: 'c2', _count: { userCourseId: 1 } },
          ]) // enrolled
          .mockResolvedValueOnce([
            { userCourseId: 'c1', _count: { userCourseId: 1 } },
          ]); // completed

        const r = await service.list(OWNER, { mine: true });

        expect(r.data[0].stats).toEqual({
          enrolledCount: 4,
          completedCount: 1,
          inProgressCount: 3,
        });
        expect(r.data[1].stats).toEqual({
          enrolledCount: 1,
          completedCount: 0,
          inProgressCount: 1,
        });
      });

      it('mine=true: курс без записей прогресса → stats нулевые (не undefined)', async () => {
        prisma.userCourse.findMany.mockResolvedValue([ownedRow('c1')]);
        prisma.userCoursePlayProgress.groupBy.mockResolvedValue([]);

        const r = await service.list(OWNER, { mine: true });

        expect(r.data[0].stats).toEqual({
          enrolledCount: 0,
          completedCount: 0,
          inProgressCount: 0,
        });
      });

      it('mine=false (публичные): stats не возвращаются для не-owner записей', async () => {
        prisma.userCourse.findMany.mockResolvedValue([
          {
            id: 'c1',
            ownerId: 'someone-else',
            slug: 's1',
            title: 't',
            description: null,
            isPublic: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            _count: { lessons: 0 },
          },
        ]);

        const r = await service.list(OWNER, { mine: false });
        expect(r.data[0].stats).toBeUndefined();
        // groupBy не должен дёргаться, если ownedIds пуст.
        expect(prisma.userCoursePlayProgress.groupBy).not.toHaveBeenCalled();
      });

      it('mine=false с собственным курсом среди публичных → stats есть только для своих', async () => {
        prisma.userCourse.findMany.mockResolvedValue([
          {
            id: 'mine',
            ownerId: OWNER,
            slug: 'm',
            title: 't',
            description: null,
            isPublic: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            _count: { lessons: 0 },
          },
          {
            id: 'foreign',
            ownerId: 'other',
            slug: 'f',
            title: 't',
            description: null,
            isPublic: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            _count: { lessons: 0 },
          },
        ]);
        prisma.userCoursePlayProgress.groupBy
          .mockResolvedValueOnce([
            { userCourseId: 'mine', _count: { userCourseId: 2 } },
          ])
          .mockResolvedValueOnce([]);

        const r = await service.list(OWNER, { mine: false });

        const mine = r.data.find((d) => d.id === 'mine');
        const foreign = r.data.find((d) => d.id === 'foreign');
        expect(mine!.stats).toEqual({
          enrolledCount: 2,
          completedCount: 0,
          inProgressCount: 2,
        });
        expect(foreign!.stats).toBeUndefined();
      });

      it('батч: ровно 2 groupBy, независимо от числа курсов', async () => {
        prisma.userCourse.findMany.mockResolvedValue([
          ownedRow('c1'),
          ownedRow('c2'),
          ownedRow('c3'),
          ownedRow('c4'),
          ownedRow('c5'),
        ]);
        prisma.userCoursePlayProgress.groupBy.mockResolvedValue([]);

        await service.list(OWNER, { mine: true });

        expect(prisma.userCoursePlayProgress.groupBy).toHaveBeenCalledTimes(2);
      });
    });
  });

  // ─── listEnrolled (KS-1889) ────────────────────────────────────────

  describe('listEnrolled', () => {
    const STUDENT = 'student-1';

    function progressRow(opts: {
      courseId: string;
      ownerId: string;
      isPublic?: boolean;
      slug: string;
      title?: string;
      lessonCount?: number;
      completedLessonsCount?: number;
      completedAt?: Date | null;
      lastActivityAt?: Date;
    }) {
      return {
        userId: STUDENT,
        userCourseId: opts.courseId,
        completedLessonsCount: opts.completedLessonsCount ?? 0,
        startedAt: new Date('2026-04-01'),
        lastActivityAt: opts.lastActivityAt ?? new Date('2026-04-10'),
        completedAt: opts.completedAt ?? null,
        course: {
          id: opts.courseId,
          ownerId: opts.ownerId,
          slug: opts.slug,
          title: opts.title ?? 'Course',
          description: null,
          isPublic: opts.isPublic ?? true,
          createdAt: new Date('2026-04-01'),
          updatedAt: new Date('2026-04-02'),
          _count: { lessons: opts.lessonCount ?? 1 },
        },
      };
    }

    // Gherkin: «Студент видит свои enrolled курсы»
    it('пройден чужой курс A + начат чужой курс B → оба видны с прогрессом', async () => {
      prisma.userCoursePlayProgress.findMany.mockResolvedValue([
        progressRow({
          courseId: 'a',
          ownerId: 'author-a',
          slug: 'course-a',
          title: 'Course A',
          lessonCount: 4,
          completedLessonsCount: 4,
          completedAt: new Date('2026-04-12T10:00:00Z'),
          lastActivityAt: new Date('2026-04-12T10:00:00Z'),
        }),
        progressRow({
          courseId: 'b',
          ownerId: 'author-b',
          slug: 'course-b',
          title: 'Course B',
          lessonCount: 3,
          completedLessonsCount: 1,
          completedAt: null,
          lastActivityAt: new Date('2026-04-11T10:00:00Z'),
        }),
      ]);

      const r = await service.listEnrolled(STUDENT);

      expect(r.data).toHaveLength(2);
      expect(r.data[0].slug).toBe('course-a');
      expect(r.data[0].progress.completedAt).not.toBeNull();
      expect(r.data[0].progress.completedLessonsCount).toBe(4);
      expect(r.data[0].lessonCount).toBe(4);
      expect(r.data[1].slug).toBe('course-b');
      expect(r.data[1].progress.completedAt).toBeNull();
      expect(r.data[1].progress.completedLessonsCount).toBe(1);
      expect(r.data[1].lessonCount).toBe(3);
    });

    // Gherkin: «Свои курсы не попадают в enrolled»
    it('фильтр where: { ownerId: { not: userId } } исключает свои курсы', async () => {
      prisma.userCoursePlayProgress.findMany.mockResolvedValue([]);

      await service.listEnrolled(STUDENT);

      expect(prisma.userCoursePlayProgress.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: STUDENT,
            course: { ownerId: { not: STUDENT } },
          },
        }),
      );
    });

    it('сортировка по lastActivityAt DESC', async () => {
      prisma.userCoursePlayProgress.findMany.mockResolvedValue([]);
      await service.listEnrolled(STUDENT);
      expect(prisma.userCoursePlayProgress.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { lastActivityAt: 'desc' },
        }),
      );
    });

    it('include подтягивает course с _count.lessons (без второго запроса)', async () => {
      prisma.userCoursePlayProgress.findMany.mockResolvedValue([]);
      await service.listEnrolled(STUDENT);
      expect(prisma.userCoursePlayProgress.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            course: {
              include: { _count: { select: { lessons: true } } },
            },
          },
        }),
      );
    });

    it('пустой результат → data: []', async () => {
      prisma.userCoursePlayProgress.findMany.mockResolvedValue([]);
      const r = await service.listEnrolled(STUDENT);
      expect(r.data).toEqual([]);
    });

    // KS-1885: stats — авторские метрики, в студенческой вкладке их быть не должно.
    it('stats не включается в DTO записи', async () => {
      prisma.userCoursePlayProgress.findMany.mockResolvedValue([
        progressRow({
          courseId: 'a',
          ownerId: 'author-a',
          slug: 'course-a',
        }),
      ]);
      const r = await service.listEnrolled(STUDENT);
      // `stats` отсутствует в типе UserEnrolledCourseDto (Omit), но и
      // в runtime'е ничего лишнего не приходит — проверяем оба факта:
      // ключа нет в объекте, и count/groupBy не вызывались.
      const raw = r.data[0] as unknown as Record<string, unknown>;
      expect(raw.stats).toBeUndefined();
      expect('stats' in r.data[0]).toBe(false);
      expect(prisma.userCoursePlayProgress.count).not.toHaveBeenCalled();
      expect(prisma.userCoursePlayProgress.groupBy).not.toHaveBeenCalled();
    });

    // Edge: автор перевёл публичный курс в приватный после того, как
    // студент его начал — запись progress остаётся, курс в выборке
    // тоже. Возвращаем как есть; FE сам решит про индикацию.
    it('приватный чужой курс с записью прогресса попадает в DTO как есть', async () => {
      prisma.userCoursePlayProgress.findMany.mockResolvedValue([
        progressRow({
          courseId: 'priv',
          ownerId: 'author-x',
          slug: 'now-private',
          isPublic: false,
          completedLessonsCount: 2,
          completedAt: new Date('2026-04-05'),
        }),
      ]);
      const r = await service.listEnrolled(STUDENT);
      expect(r.data).toHaveLength(1);
      expect(r.data[0].isPublic).toBe(false);
      expect(r.data[0].progress.completedAt).not.toBeNull();
    });

    it('один запрос к БД (без N+1)', async () => {
      prisma.userCoursePlayProgress.findMany.mockResolvedValue([
        progressRow({ courseId: 'a', ownerId: 'x', slug: 'a' }),
        progressRow({ courseId: 'b', ownerId: 'y', slug: 'b' }),
        progressRow({ courseId: 'c', ownerId: 'z', slug: 'c' }),
      ]);
      await service.listEnrolled(STUDENT);
      expect(prisma.userCoursePlayProgress.findMany).toHaveBeenCalledTimes(1);
      // Никаких дополнительных findUnique / count — всё в одном запросе.
      expect(prisma.userCourse.findUnique).not.toHaveBeenCalled();
      expect(prisma.userCourse.findMany).not.toHaveBeenCalled();
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

    // ─── KS-1885: stats для автора ───────────────────────────────
    describe('stats для автора (KS-1885)', () => {
      const ownerCourseRow = (overrides: Partial<{ ownerId: string }> = {}) => ({
        id: 'c1',
        ownerId: OWNER,
        slug: 's',
        title: 't',
        description: null,
        isPublic: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { lessons: 0 },
        lessons: [],
        ...overrides,
      });

      // Gherkin: «Автор смотрит свой курс»
      it('owner получает stats { enrolledCount, completedCount, inProgressCount }', async () => {
        prisma.userCourse.findUnique.mockResolvedValue(ownerCourseRow());
        prisma.userCoursePlayProgress.findUnique.mockResolvedValue(null);
        // 5 enrolled, 2 completed → 3 in-progress.
        prisma.userCoursePlayProgress.count
          .mockResolvedValueOnce(5)  // enrolled
          .mockResolvedValueOnce(2); // completed

        const r = await service.getBySlug(OWNER, 's');

        expect(r.course.stats).toEqual({
          enrolledCount: 5,
          completedCount: 2,
          inProgressCount: 3,
        });
      });

      // Gherkin: «Не-автор смотрит публичный курс»
      it('не-owner на публичный курс → stats отсутствует', async () => {
        prisma.userCourse.findUnique.mockResolvedValue(ownerCourseRow());
        prisma.userCoursePlayProgress.findUnique.mockResolvedValue(null);

        const r = await service.getBySlug('some-student', 's');

        expect(r.course.stats).toBeUndefined();
        // count для stats не должен дёргаться — защита от утечек агрегатов.
        expect(prisma.userCoursePlayProgress.count).not.toHaveBeenCalled();
      });

      it('owner с пустым курсом → stats нули', async () => {
        prisma.userCourse.findUnique.mockResolvedValue(ownerCourseRow());
        prisma.userCoursePlayProgress.findUnique.mockResolvedValue(null);
        prisma.userCoursePlayProgress.count
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0);

        const r = await service.getBySlug(OWNER, 's');

        expect(r.course.stats).toEqual({
          enrolledCount: 0,
          completedCount: 0,
          inProgressCount: 0,
        });
      });

      it('count-запросы используют where: { userCourseId } (по индексу)', async () => {
        prisma.userCourse.findUnique.mockResolvedValue(ownerCourseRow());
        prisma.userCoursePlayProgress.findUnique.mockResolvedValue(null);
        prisma.userCoursePlayProgress.count.mockResolvedValue(0);

        await service.getBySlug(OWNER, 's');

        const calls = prisma.userCoursePlayProgress.count.mock.calls;
        expect(calls[0][0]).toEqual({ where: { userCourseId: 'c1' } });
        expect(calls[1][0]).toEqual({
          where: { userCourseId: 'c1', completedAt: { not: null } },
        });
      });

      it('inProgressCount = max(enrolled - completed, 0) — clamp от рассинхрона', async () => {
        // Если completed > enrolled (теоретически невозможно — completed
        // is a subset, но защищаемся от рассинхрона миграций).
        prisma.userCourse.findUnique.mockResolvedValue(ownerCourseRow());
        prisma.userCoursePlayProgress.findUnique.mockResolvedValue(null);
        prisma.userCoursePlayProgress.count
          .mockResolvedValueOnce(2)  // enrolled
          .mockResolvedValueOnce(5); // completed (impossible, but clamp)

        const r = await service.getBySlug(OWNER, 's');
        expect(r.course.stats?.inProgressCount).toBe(0);
      });
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

    it('20-й курс проходит, 21-й → 400 "Courses per user limit reached"', async () => {
      prisma.userCourse.create.mockImplementation(async ({ data }: any) => ({
        id: 'c', ...data, description: data.description ?? null,
        createdAt: new Date(), updatedAt: new Date(), _count: { lessons: 0 },
      }));

      // 20 уже существует → 21-й падает.
      prisma.userCourse.count.mockResolvedValue(20);
      await expect(service.create(OWNER, { title: 'Twenty first' })).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('Courses per user limit'),
      });
      expect(prisma.userCourse.create).not.toHaveBeenCalled();
    });

    it('граница: ровно 19 существующих → 20-й создаётся', async () => {
      prisma.userCourse.count.mockResolvedValue(19);
      prisma.userCourse.create.mockImplementation(async ({ data }: any) => ({
        id: 'c', ...data, description: data.description ?? null,
        createdAt: new Date(), updatedAt: new Date(), _count: { lessons: 0 },
      }));
      await expect(service.create(OWNER, { title: 'OK' })).resolves.toBeDefined();
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

    it('30 уроков в курсе → 31-й падает 400 "Lessons per course limit reached"', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER });
      prisma.userLesson.count.mockResolvedValue(30);
      await expect(
        service.addLesson(OWNER, 'c1', { title: 'L' }),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('Lessons per course limit'),
      });
      expect(prisma.userLesson.create).not.toHaveBeenCalled();
    });

    it('граница: 29 уроков → 30-й создаётся', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER });
      prisma.userLesson.count.mockResolvedValue(29);
      prisma.userLesson.findFirst.mockResolvedValue({ order: 28 });
      prisma.userLesson.create.mockImplementation(async ({ data }: any) => ({
        id: 'l', ...data, estMinutes: data.estMinutes ?? null, _count: { steps: 0 },
      }));
      await expect(service.addLesson(OWNER, 'c1', { title: 'L' })).resolves.toBeDefined();
    });

    // KS-1881: добавление урока инвалидирует «курс пройден» у всех
    // студентов, у кого `completedAt` стоял.
    it('сбрасывает completedAt у всех студентов с пройденным курсом', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER });
      prisma.userLesson.findFirst.mockResolvedValue(null);
      prisma.userLesson.create.mockImplementation(async ({ data }: any) => ({
        id: 'l1', ...data, estMinutes: null, _count: { steps: 0 },
      }));

      await service.addLesson(OWNER, 'c1', { title: 'L' });

      expect(prisma.userCoursePlayProgress.updateMany).toHaveBeenCalledWith({
        where: { userCourseId: 'c1', completedAt: { not: null } },
        data: { completedAt: null },
      });
    });

    it('reset выполняется ВНУТРИ транзакции вместе с create урока', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER });
      prisma.userLesson.findFirst.mockResolvedValue(null);
      prisma.userLesson.create.mockImplementation(async ({ data }: any) => ({
        id: 'l1', ...data, estMinutes: null, _count: { steps: 0 },
      }));

      await service.addLesson(OWNER, 'c1', { title: 'L' });

      // updateMany вызвался через `tx` (тот же объект, что в callback'е $transaction).
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.userCoursePlayProgress.updateMany).toHaveBeenCalledTimes(1);
      // create урока вызван до updateMany — порядок важен:
      // если бы reset был раньше, новый урок попал бы в курс уже без
      // completedAt, что концептуально то же; но мы фиксируем порядок
      // «создал → инвалидировал», как в коде.
      const createCallOrder = prisma.userLesson.create.mock.invocationCallOrder[0];
      const updateManyOrder = prisma.userCoursePlayProgress.updateMany.mock.invocationCallOrder[0];
      expect(createCallOrder).toBeLessThan(updateManyOrder);
    });
  });

  // ─── reorderLessons (KS-1862) ────────────────────────────────────

  describe('reorderLessons', () => {
    beforeEach(() => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER });
      prisma.userLesson.update.mockResolvedValue({});
    });

    it('выставляет order по порядку id в массиве (две фазы)', async () => {
      prisma.userLesson.findMany.mockResolvedValue([
        { id: 'a' }, { id: 'b' }, { id: 'c' },
      ]);

      await service.reorderLessons(OWNER, 'c1', { ids: ['c', 'a', 'b'] });

      // 6 update-вызовов: 3 в offset + 3 в финальные значения.
      expect(prisma.userLesson.update).toHaveBeenCalledTimes(6);

      const finalCalls = prisma.userLesson.update.mock.calls.slice(3);
      expect(finalCalls).toContainEqual([{ where: { id: 'c' }, data: { order: 0 } }]);
      expect(finalCalls).toContainEqual([{ where: { id: 'a' }, data: { order: 1 } }]);
      expect(finalCalls).toContainEqual([{ where: { id: 'b' }, data: { order: 2 } }]);
    });

    it('первая фаза — offset 1_000_000+idx (snapshot первых трёх вызовов)', async () => {
      prisma.userLesson.findMany.mockResolvedValue([
        { id: 'a' }, { id: 'b' }, { id: 'c' },
      ]);

      await service.reorderLessons(OWNER, 'c1', { ids: ['c', 'a', 'b'] });

      const firstPhase = prisma.userLesson.update.mock.calls.slice(0, 3);
      expect(firstPhase).toContainEqual([
        { where: { id: 'c' }, data: { order: 1_000_000 } },
      ]);
      expect(firstPhase).toContainEqual([
        { where: { id: 'a' }, data: { order: 1_000_001 } },
      ]);
      expect(firstPhase).toContainEqual([
        { where: { id: 'b' }, data: { order: 1_000_002 } },
      ]);
    });

    it('чужой id в ids → 400, без апдейтов', async () => {
      prisma.userLesson.findMany.mockResolvedValue([
        { id: 'a' }, { id: 'b' },
      ]);
      await expect(
        service.reorderLessons(OWNER, 'c1', { ids: ['a', 'x'] }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.userLesson.update).not.toHaveBeenCalled();
    });

    it('неполный список (не все уроки) → 400', async () => {
      prisma.userLesson.findMany.mockResolvedValue([
        { id: 'a' }, { id: 'b' }, { id: 'c' },
      ]);
      await expect(
        service.reorderLessons(OWNER, 'c1', { ids: ['a', 'b'] }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.userLesson.update).not.toHaveBeenCalled();
    });

    it('дубли в ids → 400', async () => {
      prisma.userLesson.findMany.mockResolvedValue([
        { id: 'a' }, { id: 'b' }, { id: 'c' },
      ]);
      // length=3, все принадлежат курсу, но 'a' повторяется — ожидаем отказ.
      await expect(
        service.reorderLessons(OWNER, 'c1', { ids: ['a', 'a', 'b'] }),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('unique'),
      });
      expect(prisma.userLesson.update).not.toHaveBeenCalled();
    });

    it('пустой ids → 400', async () => {
      await expect(
        service.reorderLessons(OWNER, 'c1', { ids: [] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('чужой owner → 403 (до входа в транзакцию)', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: 'someone-else' });
      await expect(
        service.reorderLessons(OWNER, 'c1', { ids: ['a'] }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.userLesson.findMany).not.toHaveBeenCalled();
      expect(prisma.userLesson.update).not.toHaveBeenCalled();
    });
  });
});
