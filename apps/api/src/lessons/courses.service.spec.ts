import { CoursesService } from './courses.service';

describe('CoursesService.recommendLevel (KS-1767 / ADR-024 §2.3)', () => {
  let service: CoursesService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn() },
      course: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn() },
      userCourseProgress: { findMany: jest.fn(), findUnique: jest.fn() },
      userLessonProgress: { findMany: jest.fn(), count: jest.fn() },
      lessonReview: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new CoursesService(prisma);
  });

  // ── Дефолт для анонима / отсутствующего пользователя ───────────

  it('anonymous → beginner (reason=default)', async () => {
    const r = await service.recommendLevel(null);
    expect(r).toEqual({ level: 'beginner', reason: 'default' });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('не найденный userId → beginner (reason=default)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const r = await service.recommendLevel('unknown-user');
    expect(r).toEqual({ level: 'beginner', reason: 'default' });
  });

  // ── Границы порогов (ADR-024 §2.3: <1200 / <1800 / ≥1800) ───────

  describe('границы порогов', () => {
    async function levelAt(rating: number) {
      prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: rating });
      const r = await service.recommendLevel('u');
      return r;
    }

    it('rating=0 → beginner', async () => {
      const r = await levelAt(0);
      expect(r?.level).toBe('beginner');
      expect(r?.reason).toBe('rating_puzzle');
      expect(r?.ratingPuzzle).toBe(0);
    });

    it('rating=1199 (чуть ниже порога 1200) → beginner', async () => {
      const r = await levelAt(1199);
      expect(r?.level).toBe('beginner');
    });

    it('rating=1200 (точно на нижней границе intermediate) → intermediate', async () => {
      const r = await levelAt(1200);
      expect(r?.level).toBe('intermediate');
    });

    it('rating=1201 → intermediate', async () => {
      const r = await levelAt(1201);
      expect(r?.level).toBe('intermediate');
    });

    it('rating=1500 (середина intermediate) → intermediate', async () => {
      const r = await levelAt(1500);
      expect(r?.level).toBe('intermediate');
    });

    it('rating=1799 (чуть ниже порога 1800) → intermediate', async () => {
      const r = await levelAt(1799);
      expect(r?.level).toBe('intermediate');
    });

    it('rating=1800 (точно на нижней границе advanced) → advanced', async () => {
      const r = await levelAt(1800);
      expect(r?.level).toBe('advanced');
    });

    it('rating=2500 (далеко в advanced) → advanced', async () => {
      const r = await levelAt(2500);
      expect(r?.level).toBe('advanced');
    });
  });

  // ── Связка с listCourses: recommendedLevel в ответе API ─────────

  it('listCourses прокидывает рекомендацию в ответ', async () => {
    prisma.course.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue({ ratingPuzzle: 1500 });
    prisma.userCourseProgress.findMany.mockResolvedValue([]);
    const res = await service.listCourses('u');
    expect(res.recommendedLevel).toBe('intermediate');
  });

  it('listCourses для анонима возвращает recommendedLevel=beginner', async () => {
    prisma.course.findMany.mockResolvedValue([]);
    const res = await service.listCourses(null);
    expect(res.recommendedLevel).toBe('beginner');
  });
});

describe('CoursesService.getCourseBySlug — SM-2 поля (KS-1809 / L-22)', () => {
  let service: CoursesService;
  let prisma: any;

  const courseId = 'C1';
  const lessonId = 'L1';
  const userId = 'u1';

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn() },
      course: (() => {
        // KS-2639 / ADR-054 §3.1 п.5. После Phase A `getCourseBySlug` ищет
        // системный курс через `findFirst({ slug, lang, ownerId: null })`,
        // а не через старый `findUnique({slug_lang})`. Чтобы не дублировать
        // payload — общий resolver для обоих методов.
        const courseStub = {
          id: courseId,
          slug: 'beginner',
          level: 'beginner',
          titleKey: 'c.title',
          descriptionKey: 'c.desc',
          order: 0,
          isPublished: true,
          createdAt: new Date('2026-04-01T00:00:00Z'),
          updatedAt: new Date('2026-04-01T00:00:00Z'),
          lessons: [
            {
              id: lessonId,
              slug: 'l1',
              order: 0,
              blockKey: 'intro',
              kind: 'theory',
              titleKey: 'l.title',
              summaryKey: 'l.summary',
              isPublished: true,
              _count: { steps: 3 },
            },
          ],
        };
        return {
          findUnique: jest.fn().mockResolvedValue(courseStub),
          findFirst: jest.fn().mockResolvedValue(courseStub),
        };
      })(),
      userLessonProgress: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
      userCourseProgress: { findUnique: jest.fn().mockResolvedValue(null) },
      lessonReview: { findMany: jest.fn() },
    };
    service = new CoursesService(prisma);
  });

  it('для авторизованного — прокидывает masteredAt и dueAt в CourseLessonSummary', async () => {
    prisma.userLessonProgress.findMany.mockResolvedValue([
      {
        lessonId,
        completedAt: new Date('2026-04-10T00:00:00Z'),
        startedAt: new Date('2026-04-09T00:00:00Z'),
        masteredAt: new Date('2026-04-10T00:00:00Z'),
      },
    ]);
    prisma.lessonReview.findMany.mockResolvedValue([
      { lessonId, dueAt: new Date('2026-04-17T00:00:00Z') },
    ]);

    const res = await service.getCourseBySlug('beginner', userId);

    expect(res.lessons[0].masteredAt).toBe('2026-04-10T00:00:00.000Z');
    expect(res.lessons[0].dueAt).toBe('2026-04-17T00:00:00.000Z');
    expect(res.lessons[0].progressState).toBe('completed');
  });

  it('для авторизованного без LessonReview — dueAt=null', async () => {
    prisma.userLessonProgress.findMany.mockResolvedValue([
      {
        lessonId,
        completedAt: new Date('2026-04-10T00:00:00Z'),
        startedAt: new Date('2026-04-09T00:00:00Z'),
        masteredAt: null,
      },
    ]);
    prisma.lessonReview.findMany.mockResolvedValue([]);

    const res = await service.getCourseBySlug('beginner', userId);

    expect(res.lessons[0].masteredAt).toBeNull();
    expect(res.lessons[0].dueAt).toBeNull();
  });

  it('для анонима masteredAt/dueAt отсутствуют (undefined)', async () => {
    const res = await service.getCourseBySlug('beginner', null);

    expect(res.lessons[0].masteredAt).toBeUndefined();
    expect(res.lessons[0].dueAt).toBeUndefined();
    expect(prisma.lessonReview.findMany).not.toHaveBeenCalled();
  });

  // KS-1992: completedStepsCount считается из stepsState внутри
  // UserLessonProgress (count('done')).
  it('completedStepsCount: для урока с прогрессом — count(stepsState["done"])', async () => {
    prisma.userLessonProgress.findMany.mockResolvedValue([
      {
        lessonId,
        completedAt: null,
        startedAt: new Date('2026-04-26T00:00:00Z'),
        masteredAt: null,
        updatedAt: new Date('2026-04-26T00:00:00Z'),
        stepsState: {
          's1': 'done',
          's2': 'done',
          's3': 'failed',
          's4': 'in_progress',
          's5': 'done',
        },
      },
    ]);
    prisma.lessonReview.findMany.mockResolvedValue([]);

    const res = await service.getCourseBySlug('beginner', userId);
    expect(res.lessons[0].completedStepsCount).toBe(3);
    expect(res.lessons[0].progressState).toBe('in_progress');
  });

  it('completedStepsCount: для урока без прогресса — 0', async () => {
    prisma.userLessonProgress.findMany.mockResolvedValue([]);
    prisma.lessonReview.findMany.mockResolvedValue([]);
    const res = await service.getCourseBySlug('beginner', userId);
    expect(res.lessons[0].completedStepsCount).toBe(0);
    expect(res.lessons[0].progressState).toBe('not_started');
  });

  it('completedStepsCount: для анонима — 0 (без запроса прогресса)', async () => {
    const res = await service.getCourseBySlug('beginner', null);
    expect(res.lessons[0].completedStepsCount).toBe(0);
  });
});

describe('CoursesService — Lessons-redesign card fields (KS-1933/KS-1934/KS-1935)', () => {
  let service: CoursesService;
  let prisma: any;

  const baseCourseRow = {
    id: 'c1',
    slug: 'beginner',
    level: 'beginner',
    titleKey: 'c.title',
    descriptionKey: 'c.desc',
    order: 0,
    isPublished: true,
    coverUrl: 'https://cdn.example/cover.png',
    difficulty: 3,
    estimatedMinutes: 90,
    audienceI18nKey: 'c.audience',
    hookI18nKey: 'c.hook',
    outcomeI18nKey: 'c.outcome',
    tags: ['endgame', 'tactics'],
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
  };

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn() },
      course: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn() },
      userCourseProgress: { findMany: jest.fn(), findUnique: jest.fn() },
      userLessonProgress: { findMany: jest.fn(), count: jest.fn() },
      lessonReview: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new CoursesService(prisma);
  });

  it('listCourses прокидывает все новые поля карточки в DTO', async () => {
    prisma.course.findMany.mockResolvedValue([
      { ...baseCourseRow, _count: { lessons: 5 } },
    ]);
    const res = await service.listCourses(null);

    expect(res.data).toHaveLength(1);
    const item = res.data[0];
    expect(item.coverUrl).toBe('https://cdn.example/cover.png');
    expect(item.difficulty).toBe(3);
    expect(item.estimatedMinutes).toBe(90);
    expect(item.audienceI18nKey).toBe('c.audience');
    expect(item.hookI18nKey).toBe('c.hook');
    expect(item.outcomeI18nKey).toBe('c.outcome');
    expect(item.tags).toEqual(['endgame', 'tactics']);
  });

  it('listCourses корректно обрабатывает null-значения новых полей', async () => {
    prisma.course.findMany.mockResolvedValue([
      {
        ...baseCourseRow,
        coverUrl: null,
        // difficulty в БД NOT NULL c default 2 — здесь именно дефолт
        difficulty: 2,
        estimatedMinutes: null,
        audienceI18nKey: null,
        hookI18nKey: null,
        outcomeI18nKey: null,
        tags: [],
        _count: { lessons: 0 },
      },
    ]);
    const res = await service.listCourses(null);

    const item = res.data[0];
    expect(item.coverUrl).toBeNull();
    expect(item.difficulty).toBe(2);
    expect(item.estimatedMinutes).toBeNull();
    expect(item.audienceI18nKey).toBeNull();
    expect(item.hookI18nKey).toBeNull();
    expect(item.outcomeI18nKey).toBeNull();
    expect(item.tags).toEqual([]);
  });

  it('getCourseBySlug прокидывает все новые поля карточки в DTO курса', async () => {
    // KS-2639 / ADR-054: после Phase A `getCourseBySlug` ищет курс
    // через `findFirst` (partial-unique namespace), не `findUnique`.
    const stub = { ...baseCourseRow, lessons: [] };
    prisma.course.findUnique.mockResolvedValue(stub);
    prisma.course.findFirst.mockResolvedValue(stub);
    prisma.userCourseProgress.findUnique = jest.fn().mockResolvedValue(null);

    const res = await service.getCourseBySlug('beginner', null);

    expect(res.course.coverUrl).toBe('https://cdn.example/cover.png');
    expect(res.course.difficulty).toBe(3);
    expect(res.course.estimatedMinutes).toBe(90);
    expect(res.course.audienceI18nKey).toBe('c.audience');
    expect(res.course.hookI18nKey).toBe('c.hook');
    expect(res.course.outcomeI18nKey).toBe('c.outcome');
    expect(res.course.tags).toEqual(['endgame', 'tactics']);
  });
});

// ── KS-1955: progress.lastActivityAt + currentLesson* в Hero Variant B ─

describe('CoursesService — progress.lastActivityAt / currentLesson* (KS-1955)', () => {
  let service: CoursesService;
  let prisma: any;

  const userId = 'u1';
  const courseId = 'c1';

  const courseRow = {
    id: courseId,
    slug: 'beginner',
    level: 'beginner',
    titleKey: 'c.title',
    descriptionKey: 'c.desc',
    order: 0,
    isPublished: true,
    coverUrl: null,
    difficulty: 2,
    estimatedMinutes: null,
    audienceI18nKey: null,
    hookI18nKey: null,
    outcomeI18nKey: null,
    tags: [],
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    _count: { lessons: 3 },
    lessons: [
      // KS-2148: inline title пробрасывается в DTO как currentLessonTitle.
      { id: 'L1', slug: 'l-1', title: 'Lesson 1 inline', titleKey: 'l1.title', order: 0 },
      { id: 'L2', slug: 'l-2', title: 'Lesson 2 inline', titleKey: 'l2.title', order: 1 },
      { id: 'L3', slug: 'l-3', title: null, titleKey: 'l3.title', order: 2 },
    ],
  };

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ ratingPuzzle: 800 }) },
      course: {
        findMany: jest.fn().mockResolvedValue([courseRow]),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      userCourseProgress: { findMany: jest.fn(), findUnique: jest.fn() },
      userLessonProgress: { findMany: jest.fn(), count: jest.fn() },
      lessonReview: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new CoursesService(prisma);
  });

  it('listCourses: первый незавершённый урок попадает как currentLesson*', async () => {
    prisma.userCourseProgress.findMany.mockResolvedValue([
      {
        courseId,
        startedAt: new Date('2026-04-10T00:00:00Z'),
        completedAt: null,
        currentLessonId: 'L1',
        updatedAt: new Date('2026-04-15T00:00:00Z'),
      },
    ]);
    // L1 завершён, L2 и L3 — нет → текущий L2 (order=2 в 1-based).
    prisma.userLessonProgress.findMany.mockResolvedValue([
      {
        lessonId: 'L1',
        completedAt: new Date('2026-04-12T00:00:00Z'),
        updatedAt: new Date('2026-04-12T00:00:00Z'),
      },
      {
        lessonId: 'L2',
        completedAt: null,
        updatedAt: new Date('2026-04-20T00:00:00Z'),
      },
    ]);

    const res = await service.listCourses(userId);
    const p = res.data[0].progress!;

    expect(p.currentLessonSlug).toBe('l-2');
    expect(p.currentLessonTitleI18nKey).toBe('l2.title');
    // KS-2148: inline title параллельно с i18nKey.
    expect(p.currentLessonTitle).toBe('Lesson 2 inline');
    expect(p.currentLessonOrder).toBe(2);
    expect(p.lessonsCompleted).toBe(1);
  });

  it('listCourses: все уроки пройдены → currentLesson* = null', async () => {
    prisma.userCourseProgress.findMany.mockResolvedValue([
      {
        courseId,
        startedAt: new Date('2026-04-10T00:00:00Z'),
        completedAt: new Date('2026-04-25T00:00:00Z'),
        currentLessonId: null,
        updatedAt: new Date('2026-04-25T00:00:00Z'),
      },
    ]);
    prisma.userLessonProgress.findMany.mockResolvedValue([
      { lessonId: 'L1', completedAt: new Date('2026-04-11T00:00:00Z'), updatedAt: new Date('2026-04-11T00:00:00Z') },
      { lessonId: 'L2', completedAt: new Date('2026-04-13T00:00:00Z'), updatedAt: new Date('2026-04-13T00:00:00Z') },
      { lessonId: 'L3', completedAt: new Date('2026-04-25T00:00:00Z'), updatedAt: new Date('2026-04-25T00:00:00Z') },
    ]);

    const res = await service.listCourses(userId);
    const p = res.data[0].progress!;

    expect(p.currentLessonSlug).toBeNull();
    expect(p.currentLessonTitleI18nKey).toBeNull();
    expect(p.currentLessonOrder).toBeNull();
    expect(p.lessonsCompleted).toBe(3);
    expect(p.completedAt).toBe('2026-04-25T00:00:00.000Z');
  });

  it('listCourses: lastActivityAt = MAX(courseProgress.updatedAt, lessonProgress.updatedAt)', async () => {
    prisma.userCourseProgress.findMany.mockResolvedValue([
      {
        courseId,
        startedAt: new Date('2026-04-10T00:00:00Z'),
        completedAt: null,
        currentLessonId: null,
        updatedAt: new Date('2026-04-15T00:00:00Z'),
      },
    ]);
    // Самый поздний updatedAt — у L2 (2026-04-22), он и должен победить.
    prisma.userLessonProgress.findMany.mockResolvedValue([
      { lessonId: 'L1', completedAt: new Date('2026-04-12T00:00:00Z'), updatedAt: new Date('2026-04-12T00:00:00Z') },
      { lessonId: 'L2', completedAt: null, updatedAt: new Date('2026-04-22T00:00:00Z') },
    ]);

    const res = await service.listCourses(userId);
    const p = res.data[0].progress!;

    expect(p.lastActivityAt).toBe('2026-04-22T00:00:00.000Z');
  });

  it('listCourses: пользователь без UserCourseProgress → progress=null', async () => {
    prisma.userCourseProgress.findMany.mockResolvedValue([]);
    prisma.userLessonProgress.findMany.mockResolvedValue([]);

    const res = await service.listCourses(userId);
    expect(res.data[0].progress).toBeNull();
  });

  it('getCourseBySlug: маппит lastActivityAt и currentLesson*', async () => {
    // KS-2639 / ADR-054: findFirst вместо findUnique (partial-unique).
    const stub = {
      ...courseRow,
      lessons: courseRow.lessons.map((l) => ({
        ...l,
        blockKey: 'block',
        kind: 'theory',
        summaryKey: `${l.id}.summary`,
        isPublished: true,
        _count: { steps: 1 },
      })),
    };
    prisma.course.findUnique.mockResolvedValue(stub);
    prisma.course.findFirst.mockResolvedValue(stub);
    prisma.userLessonProgress.findMany.mockResolvedValue([
      {
        lessonId: 'L1',
        completedAt: new Date('2026-04-12T00:00:00Z'),
        startedAt: new Date('2026-04-10T00:00:00Z'),
        masteredAt: null,
        updatedAt: new Date('2026-04-12T00:00:00Z'),
      },
      {
        lessonId: 'L2',
        completedAt: null,
        startedAt: new Date('2026-04-13T00:00:00Z'),
        masteredAt: null,
        updatedAt: new Date('2026-04-23T00:00:00Z'),
      },
    ]);
    prisma.userCourseProgress.findUnique.mockResolvedValue({
      userId,
      courseId,
      startedAt: new Date('2026-04-10T00:00:00Z'),
      completedAt: null,
      currentLessonId: 'L2',
      updatedAt: new Date('2026-04-15T00:00:00Z'),
    });

    const res = await service.getCourseBySlug('beginner', userId);
    const p = res.progress!;

    expect(p.currentLessonSlug).toBe('l-2');
    expect(p.currentLessonTitleI18nKey).toBe('l2.title');
    // KS-2148: inline title для getCourseBySlug.
    expect(p.currentLessonTitle).toBe('Lesson 2 inline');
    expect(p.currentLessonOrder).toBe(2);
    // MAX = updatedAt L2 (2026-04-23), не courseProgress.updatedAt (2026-04-15).
    expect(p.lastActivityAt).toBe('2026-04-23T00:00:00.000Z');
  });
});

// ── KS-1966 (Admin API B-4): inline-поля в публичных DTO ───────────────

describe('CoursesService — inline fields mapping (KS-1964/KS-1966)', () => {
  let service: CoursesService;
  let prisma: any;

  function baseCourseRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'c1',
      slug: 'beginner',
      level: 'beginner',
      titleKey: 'c.title',
      descriptionKey: 'c.desc',
      order: 0,
      isPublished: true,
      coverUrl: null,
      difficulty: 2,
      estimatedMinutes: null,
      audienceI18nKey: 'c.audience.key',
      hookI18nKey: 'c.hook.key',
      outcomeI18nKey: 'c.outcome.key',
      tags: [],
      title: null,
      description: null,
      audience: null,
      hook: null,
      outcome: null,
      createdAt: new Date('2026-04-01T00:00:00Z'),
      updatedAt: new Date('2026-04-01T00:00:00Z'),
      _count: { lessons: 0 },
      lessons: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn() },
      course: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn() },
      userCourseProgress: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
      userLessonProgress: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn() },
      lessonReview: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new CoursesService(prisma);
  });

  it('listCourses: с заполненным inline → отдаёт inline + i18nKey рядом (FE сам решит)', async () => {
    prisma.course.findMany.mockResolvedValue([
      baseCourseRow({
        title: 'Капабланка для начинающих',
        description: 'Курс по основам шахмат',
        audience: 'Новички',
        hook: 'Откроешь правила и базовые тактики',
        outcome: 'Сыграешь первую партию без зевков',
      }),
    ]);
    const res = await service.listCourses(null);
    const item = res.data[0] as any;

    expect(item.title).toBe('Капабланка для начинающих');
    expect(item.description).toBe('Курс по основам шахмат');
    expect(item.audience).toBe('Новички');
    expect(item.hook).toBe('Откроешь правила и базовые тактики');
    expect(item.outcome).toBe('Сыграешь первую партию без зевков');
    // i18n-ключи остаются на месте — fallback на FE.
    expect(item.titleI18nKey).toBe('c.title');
    expect(item.audienceI18nKey).toBe('c.audience.key');
  });

  it('listCourses: пустой inline → null (FE сделает fallback на i18nKey)', async () => {
    prisma.course.findMany.mockResolvedValue([baseCourseRow()]);
    const res = await service.listCourses(null);
    const item = res.data[0] as any;

    expect(item.title).toBeNull();
    expect(item.description).toBeNull();
    expect(item.audience).toBeNull();
    expect(item.hook).toBeNull();
    expect(item.outcome).toBeNull();
    expect(item.titleI18nKey).toBe('c.title');
    expect(item.audienceI18nKey).toBe('c.audience.key');
  });

  it('getCourseBySlug: маппит inline для course и для lessons', async () => {
    // KS-2639 / ADR-054: findFirst вместо findUnique (partial-unique).
    const stub = baseCourseRow({
      title: 'Inline title',
      description: 'Inline desc',
      audience: 'Inline audience',
      hook: 'Inline hook',
      outcome: 'Inline outcome',
      lessons: [
        {
          id: 'L1',
          slug: 'l-1',
          order: 0,
          blockKey: 'block',
          kind: 'theory',
          titleKey: 'L1.title',
          summaryKey: 'L1.summary',
          isPublished: true,
          title: 'Урок 1',
          summary: 'Краткий конспект',
          _count: { steps: 1 },
        },
        {
          id: 'L2',
          slug: 'l-2',
          order: 1,
          blockKey: 'block',
          kind: 'theory',
          titleKey: 'L2.title',
          summaryKey: 'L2.summary',
          isPublished: true,
          title: null,
          summary: null,
          _count: { steps: 1 },
        },
      ],
    });
    prisma.course.findUnique.mockResolvedValue(stub);
    prisma.course.findFirst.mockResolvedValue(stub);

    const res = await service.getCourseBySlug('beginner', null);

    expect((res.course as any).title).toBe('Inline title');
    expect((res.course as any).audience).toBe('Inline audience');
    expect((res.course as any).hook).toBe('Inline hook');
    expect((res.course as any).outcome).toBe('Inline outcome');

    expect(res.lessons[0].title).toBe('Урок 1');
    expect(res.lessons[0].summary).toBe('Краткий конспект');
    expect(res.lessons[0].titleI18nKey).toBe('L1.title');

    expect(res.lessons[1].title).toBeNull();
    expect(res.lessons[1].summary).toBeNull();
    expect(res.lessons[1].titleI18nKey).toBe('L2.title');
  });
});
