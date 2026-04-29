import { ActiveCoursesService } from './active-courses.service';

describe('ActiveCoursesService (KS-1937)', () => {
  let service: ActiveCoursesService;
  let prisma: any;

  const userId = 'u1';

  beforeEach(() => {
    prisma = {
      userCourseProgress: { findMany: jest.fn().mockResolvedValue([]) },
      userLessonProgress: { findMany: jest.fn().mockResolvedValue([]) },
      userCoursePlayProgress: { findMany: jest.fn().mockResolvedValue([]) },
      userLessonPlayProgress: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new ActiveCoursesService(prisma);
  });

  // ─── happy path ─────────────────────────────────────────────────────

  it('система + enrolled: оба источника попадают в data, сортировка по lastActivityAt DESC', async () => {
    // System: один активный курс. lastActivity у L2 = 2026-04-22.
    prisma.userCourseProgress.findMany.mockResolvedValue([
      {
        userId,
        courseId: 'sys-1',
        startedAt: new Date('2026-04-10T00:00:00Z'),
        completedAt: null,
        currentLessonId: 'sys-L1',
        updatedAt: new Date('2026-04-15T00:00:00Z'),
        course: {
          id: 'sys-1',
          slug: 'beginner',
          level: 'beginner',
          titleKey: 'sys.title',
          descriptionKey: 'sys.desc',
          isPublished: true,
          coverUrl: null,
          difficulty: 2,
          estimatedMinutes: null,
          audienceI18nKey: null,
          hookI18nKey: null,
          outcomeI18nKey: null,
          tags: [],
          _count: { lessons: 2 },
          lessons: [
            { id: 'sys-L1', slug: 'l1', title: 'L1 inline', titleKey: 'l1.title', order: 0 },
            { id: 'sys-L2', slug: 'l2', title: 'L2 inline', titleKey: 'l2.title', order: 1 },
          ],
        },
      },
    ]);
    prisma.userLessonProgress.findMany.mockResolvedValue([
      {
        lessonId: 'sys-L1',
        completedAt: new Date('2026-04-12T00:00:00Z'),
        updatedAt: new Date('2026-04-12T00:00:00Z'),
      },
      {
        lessonId: 'sys-L2',
        completedAt: null,
        updatedAt: new Date('2026-04-22T00:00:00Z'),
      },
    ]);

    // Enrolled (custom-чужой): lastActivityAt = 2026-04-25 (свежее, идёт первым).
    prisma.userCoursePlayProgress.findMany.mockResolvedValue([
      {
        userId,
        userCourseId: 'usr-1',
        completedLessonsCount: 1,
        startedAt: new Date('2026-04-20T00:00:00Z'),
        lastActivityAt: new Date('2026-04-25T00:00:00Z'),
        completedAt: null,
        course: {
          id: 'usr-1',
          slug: 'foreign-course',
          ownerId: 'other-author',
          title: 'Foreign Course',
          description: 'Some description',
          _count: { lessons: 2 },
          lessons: [
            { id: 'usr-L1', order: 0, title: 'Intro' },
            { id: 'usr-L2', order: 1, title: 'Tactics' },
          ],
        },
      },
    ]);
    prisma.userLessonPlayProgress.findMany.mockResolvedValue([
      { userLessonId: 'usr-L1', completedAt: new Date('2026-04-22T00:00:00Z') },
      { userLessonId: 'usr-L2', completedAt: null },
    ]);

    const r = await service.listActiveCourses(userId);

    expect(r.data).toHaveLength(2);

    // Свежее наверху: enrolled (2026-04-25) > system (2026-04-22).
    expect(r.data[0].kind).toBe('enrolled');
    expect(r.data[1].kind).toBe('system');

    const enrolled = r.data[0];
    expect(enrolled.kind).toBe('enrolled');
    if (enrolled.kind === 'enrolled') {
      expect(enrolled.id).toBe('usr-1');
      expect(enrolled.slug).toBe('foreign-course');
      expect(enrolled.title).toBe('Foreign Course');
      expect(enrolled.ownerId).toBe('other-author');
      expect(enrolled.lessonsCompleted).toBe(1);
      expect(enrolled.lastActivityAt).toBe('2026-04-25T00:00:00.000Z');
      expect(enrolled.currentLessonSlug).toBe('usr-L2');
      expect(enrolled.currentLessonTitle).toBe('Tactics');
      expect(enrolled.currentLessonOrder).toBe(2);
    }

    const system = r.data[1];
    expect(system.kind).toBe('system');
    if (system.kind === 'system') {
      expect(system.id).toBe('sys-1');
      expect(system.slug).toBe('beginner');
      expect(system.level).toBe('beginner');
      expect(system.titleI18nKey).toBe('sys.title');
      expect(system.lessonsCompleted).toBe(1);
      // MAX = updatedAt L2 (2026-04-22), не courseProgress.updatedAt (2026-04-15).
      expect(system.lastActivityAt).toBe('2026-04-22T00:00:00.000Z');
      expect(system.currentLessonSlug).toBe('l2');
      expect(system.currentLessonTitleI18nKey).toBe('l2.title');
      // KS-2148: inline currentLessonTitle для system-курса.
      expect(system.currentLessonTitle).toBe('L2 inline');
      expect(system.currentLessonOrder).toBe(2);
    }
  });

  // ─── фильтры ────────────────────────────────────────────────────────

  it('пустой результат → data: []', async () => {
    const r = await service.listActiveCourses(userId);
    expect(r.data).toEqual([]);
  });

  it('completedAt != null отсекаются на уровне where (не вызываются вторичные запросы)', async () => {
    await service.listActiveCourses(userId);
    expect(prisma.userCourseProgress.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId, completedAt: null },
      }),
    );
    expect(prisma.userCoursePlayProgress.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId,
          completedAt: null,
          course: { ownerId: { not: userId } },
        },
      }),
    );
  });

  it('собственные пользовательские курсы автора исключены фильтром БД', async () => {
    // Базово где-фильтр уже исключает (`ownerId: { not: userId }`),
    // но подтверждаем явно — этот контракт критичен по концепту §3.3.
    await service.listActiveCourses(userId);
    const enrolledCall = prisma.userCoursePlayProgress.findMany.mock.calls[0][0];
    expect(enrolledCall.where.course.ownerId).toEqual({ not: userId });
  });

  it('system: неопубликованный курс пропускается (защита от seed-draft)', async () => {
    prisma.userCourseProgress.findMany.mockResolvedValue([
      {
        userId,
        courseId: 'draft',
        startedAt: new Date('2026-04-10T00:00:00Z'),
        completedAt: null,
        currentLessonId: null,
        updatedAt: new Date('2026-04-15T00:00:00Z'),
        course: {
          id: 'draft',
          slug: 'draft',
          level: 'beginner',
          titleKey: 't',
          descriptionKey: 'd',
          isPublished: false, // draft
          coverUrl: null,
          difficulty: 2,
          estimatedMinutes: null,
          audienceI18nKey: null,
          hookI18nKey: null,
          outcomeI18nKey: null,
          tags: [],
          _count: { lessons: 0 },
          lessons: [],
        },
      },
    ]);
    const r = await service.listActiveCourses(userId);
    expect(r.data).toHaveLength(0);
  });

  // ─── currentLesson edge cases ──────────────────────────────────────

  it('system: все уроки пройдены → currentLesson* = null, но курс ещё в выборке (completedAt != null отсекли бы — здесь null)', async () => {
    prisma.userCourseProgress.findMany.mockResolvedValue([
      {
        userId,
        courseId: 'sys-1',
        startedAt: new Date('2026-04-10T00:00:00Z'),
        completedAt: null,
        currentLessonId: null,
        updatedAt: new Date('2026-04-25T00:00:00Z'),
        course: {
          id: 'sys-1',
          slug: 'all-done',
          level: 'beginner',
          titleKey: 't',
          descriptionKey: 'd',
          isPublished: true,
          coverUrl: null,
          difficulty: 2,
          estimatedMinutes: null,
          audienceI18nKey: null,
          hookI18nKey: null,
          outcomeI18nKey: null,
          tags: [],
          _count: { lessons: 1 },
          lessons: [{ id: 'L1', slug: 'l1', titleKey: 't1', order: 0 }],
        },
      },
    ]);
    prisma.userLessonProgress.findMany.mockResolvedValue([
      { lessonId: 'L1', completedAt: new Date('2026-04-25T00:00:00Z'), updatedAt: new Date('2026-04-25T00:00:00Z') },
    ]);
    const r = await service.listActiveCourses(userId);
    expect(r.data).toHaveLength(1);
    const item = r.data[0];
    if (item.kind !== 'system') throw new Error('expected system');
    expect(item.currentLessonSlug).toBeNull();
    expect(item.currentLessonTitleI18nKey).toBeNull();
    expect(item.currentLessonOrder).toBeNull();
  });

  // ─── batch (без N+1) ───────────────────────────────────────────────

  it('батч-запрос вместо N+1: один findMany по lessonProgress на все курсы', async () => {
    prisma.userCourseProgress.findMany.mockResolvedValue([
      {
        userId, courseId: 'a', startedAt: new Date(), completedAt: null,
        currentLessonId: null, updatedAt: new Date(),
        course: {
          id: 'a', slug: 'a', level: 'beginner', titleKey: 't', descriptionKey: 'd',
          isPublished: true, coverUrl: null, difficulty: 2, estimatedMinutes: null,
          audienceI18nKey: null, hookI18nKey: null, outcomeI18nKey: null, tags: [],
          _count: { lessons: 1 }, lessons: [{ id: 'L-a', slug: 'la', titleKey: 'ka', order: 0 }],
        },
      },
      {
        userId, courseId: 'b', startedAt: new Date(), completedAt: null,
        currentLessonId: null, updatedAt: new Date(),
        course: {
          id: 'b', slug: 'b', level: 'beginner', titleKey: 't', descriptionKey: 'd',
          isPublished: true, coverUrl: null, difficulty: 2, estimatedMinutes: null,
          audienceI18nKey: null, hookI18nKey: null, outcomeI18nKey: null, tags: [],
          _count: { lessons: 1 }, lessons: [{ id: 'L-b', slug: 'lb', titleKey: 'kb', order: 0 }],
        },
      },
    ]);
    await service.listActiveCourses(userId);
    expect(prisma.userLessonProgress.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.userLessonProgress.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId, lessonId: { in: ['L-a', 'L-b'] } },
      }),
    );
  });

  // ─── KS-1966: inline-поля в ActiveSystemCourseDto ──────────────────

  it('system: маппит inline-поля курса (title/description/audience/hook/outcome)', async () => {
    prisma.userCourseProgress.findMany.mockResolvedValue([
      {
        userId,
        courseId: 'sys-1',
        startedAt: new Date('2026-04-10T00:00:00Z'),
        completedAt: null,
        currentLessonId: null,
        updatedAt: new Date('2026-04-15T00:00:00Z'),
        course: {
          id: 'sys-1',
          slug: 'beginner',
          level: 'beginner',
          titleKey: 'c.title.key',
          descriptionKey: 'c.desc.key',
          isPublished: true,
          coverUrl: null,
          difficulty: 2,
          estimatedMinutes: null,
          audienceI18nKey: 'c.audience.key',
          hookI18nKey: 'c.hook.key',
          outcomeI18nKey: 'c.outcome.key',
          tags: [],
          title: 'Inline title',
          description: 'Inline desc',
          audience: 'Inline audience',
          hook: 'Inline hook',
          outcome: 'Inline outcome',
          _count: { lessons: 0 },
          lessons: [],
        },
      },
    ]);
    prisma.userLessonProgress.findMany.mockResolvedValue([]);
    const r = await service.listActiveCourses(userId);
    const item = r.data[0];
    if (item.kind !== 'system') throw new Error('expected system');
    expect(item.title).toBe('Inline title');
    expect(item.description).toBe('Inline desc');
    expect(item.audience).toBe('Inline audience');
    expect(item.hook).toBe('Inline hook');
    expect(item.outcome).toBe('Inline outcome');
    // i18n-ключи рядом — fallback на FE.
    expect(item.titleI18nKey).toBe('c.title.key');
    expect(item.audienceI18nKey).toBe('c.audience.key');
  });

  it('system: пустой inline → null (FE использует i18nKey)', async () => {
    prisma.userCourseProgress.findMany.mockResolvedValue([
      {
        userId, courseId: 'sys-1', startedAt: new Date(), completedAt: null,
        currentLessonId: null, updatedAt: new Date(),
        course: {
          id: 'sys-1', slug: 'beginner', level: 'beginner',
          titleKey: 'c.title.key', descriptionKey: 'c.desc.key',
          isPublished: true, coverUrl: null, difficulty: 2, estimatedMinutes: null,
          audienceI18nKey: null, hookI18nKey: null, outcomeI18nKey: null, tags: [],
          title: null, description: null, audience: null, hook: null, outcome: null,
          _count: { lessons: 0 }, lessons: [],
        },
      },
    ]);
    const r = await service.listActiveCourses(userId);
    const item = r.data[0];
    if (item.kind !== 'system') throw new Error('expected system');
    expect(item.title).toBeNull();
    expect(item.description).toBeNull();
    expect(item.audience).toBeNull();
    expect(item.hook).toBeNull();
    expect(item.outcome).toBeNull();
  });
});
