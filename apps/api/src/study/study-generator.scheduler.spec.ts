import { StudyGeneratorScheduler } from './study-generator.scheduler';

/**
 * KS-4927 / ADR-163 §4. Unit-тесты генератора по слотам:
 * несколько слотов одной тренировки → несколько planned-сессий в
 * горизонте; идемпотентность (exists) сохраняется; sessionMinutes
 * слота имеет приоритет над значением тренировки.
 */

function makeMocks() {
  const prisma = {
    studySchedule: { findMany: jest.fn().mockResolvedValue([]) },
    studySession: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    user: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ locale: 'ru' }),
    },
  };
  const profiles = {
    collect: jest.fn().mockResolvedValue({
      ratingPuzzle: 1500,
      ratingPuzzleDev: 100,
      weakThemes: [{ theme: 'fork', attempted: 5, rate: 0.4 }],
    }),
  };
  const planGenerator = {
    ratingWindow: jest.fn().mockReturnValue({ min: -100, max: 100 }),
  };
  const lessonBuilder = {
    buildLesson: jest.fn().mockResolvedValue({
      lessonId: 'lesson-1',
      courseId: 'course-1',
      courseSlug: 'personal',
      themeLabel: 'Вилка',
    }),
  };
  const material = { extract: jest.fn().mockResolvedValue(null) };
  const redis = { set: jest.fn() };
  return { prisma, profiles, planGenerator, lessonBuilder, material, redis };
}

function makeScheduler(m: ReturnType<typeof makeMocks>): StudyGeneratorScheduler {
  return new StudyGeneratorScheduler(
    m.prisma as never,
    m.redis as never,
    m.planGenerator as never,
    m.profiles as never,
    m.lessonBuilder as never,
    m.material as never,
  );
}

// Понедельник 2026-07-13 08:00 UTC (Europe/Prague = UTC+2 летом).
const NOW = new Date('2026-07-13T08:00:00Z');

const baseSchedule = {
  id: 'sch-1',
  userId: 'user-1',
  sessionMinutes: 30,
  timezone: 'Europe/Prague',
  focus: null,
};

describe('StudyGeneratorScheduler по слотам (KS-4927 / ADR-163 §4)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('создаёт сессию для каждого слота в горизонте +25 ч', async () => {
    const m = makeMocks();
    const scheduler = makeScheduler(m);

    const r = await scheduler.generateForSchedule(
      {
        ...baseSchedule,
        slots: [
          // Пн 19:00 local (17:00 UTC) — в горизонте.
          { daysOfWeek: [1], timeLocal: '19:00', sessionMinutes: null },
          // Вт 08:00 local (06:00 UTC, +22 ч) — в горизонте.
          { daysOfWeek: [2], timeLocal: '08:00', sessionMinutes: null },
        ],
      },
      NOW,
    );

    expect(r.created).toBe(2);
    expect(m.prisma.studySession.create).toHaveBeenCalledTimes(2);
    const scheduledAts = m.prisma.studySession.create.mock.calls.map(
      (c: Array<{ data: { scheduledAt: Date } }>) =>
        c[0].data.scheduledAt.toISOString(),
    );
    expect(scheduledAts).toEqual([
      '2026-07-13T17:00:00.000Z',
      '2026-07-14T06:00:00.000Z',
    ]);
  });

  it('слот вне горизонта — no_slot, сессия не создаётся', async () => {
    const m = makeMocks();
    const scheduler = makeScheduler(m);

    const r = await scheduler.generateForSchedule(
      {
        ...baseSchedule,
        // Четверг — за пределами +25 ч от понедельника 08:00 UTC.
        slots: [{ daysOfWeek: [4], timeLocal: '19:00', sessionMinutes: null }],
      },
      NOW,
    );

    expect(r.created).toBe(0);
    expect(r.outcomes[0].outcome).toBe('no_slot');
    expect(m.prisma.studySession.create).not.toHaveBeenCalled();
  });

  it('идемпотентность: существующая сессия слота — exists, без дубля', async () => {
    const m = makeMocks();
    m.prisma.studySession.findUnique.mockResolvedValue({ id: 'existing' });
    const scheduler = makeScheduler(m);

    const r = await scheduler.generateForSchedule(
      {
        ...baseSchedule,
        slots: [{ daysOfWeek: [1], timeLocal: '19:00', sessionMinutes: null }],
      },
      NOW,
    );

    expect(r.created).toBe(0);
    expect(r.outcomes[0].outcome).toBe('exists');
    expect(m.prisma.studySession.create).not.toHaveBeenCalled();
  });

  it('sessionMinutes слота приоритетнее значения тренировки (снапшот)', async () => {
    const m = makeMocks();
    const scheduler = makeScheduler(m);

    await scheduler.generateForSchedule(
      {
        ...baseSchedule,
        slots: [{ daysOfWeek: [1], timeLocal: '19:00', sessionMinutes: 60 }],
      },
      NOW,
    );

    const snapshot = m.prisma.studySession.create.mock.calls[0][0].data
      .profileSnapshot as { sessionMinutes: number };
    expect(snapshot.sessionMinutes).toBe(60);
  });

  it('без оверрайда — sessionMinutes тренировки (снапшот)', async () => {
    const m = makeMocks();
    const scheduler = makeScheduler(m);

    await scheduler.generateForSchedule(
      {
        ...baseSchedule,
        slots: [{ daysOfWeek: [1], timeLocal: '19:00', sessionMinutes: null }],
      },
      NOW,
    );

    const snapshot = m.prisma.studySession.create.mock.calls[0][0].data
      .profileSnapshot as { sessionMinutes: number };
    expect(snapshot.sessionMinutes).toBe(30);
  });

  it('generateDueSessions агрегирует created по всем тренировкам', async () => {
    const m = makeMocks();
    m.prisma.studySchedule.findMany.mockResolvedValue([
      {
        ...baseSchedule,
        slots: [{ daysOfWeek: [1], timeLocal: '19:00', sessionMinutes: null }],
      },
      {
        ...baseSchedule,
        id: 'sch-2',
        slots: [{ daysOfWeek: [1], timeLocal: '21:00', sessionMinutes: null }],
      },
    ]);
    const scheduler = makeScheduler(m);

    const created = await scheduler.generateDueSessions(NOW);

    expect(created).toBe(2);
    expect(m.prisma.studySchedule.findMany).toHaveBeenCalledWith({
      where: { active: true },
      include: { slots: true },
    });
  });
});
