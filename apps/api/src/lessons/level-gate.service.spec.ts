import { LevelGateService } from './level-gate.service';

describe('LevelGateService (KS-1770)', () => {
  let service: LevelGateService;
  let prisma: any;

  const userId = 'u1';

  function mockUser(overrides: Partial<{
    ratingPuzzle: number;
    gamesPlayedRapid: number;
    gamesPlayedBlitz: number;
    gamesPlayedClassical: number;
  }> = {}) {
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      ratingPuzzle: 1500,
      gamesPlayedRapid: 10,
      gamesPlayedBlitz: 10,
      gamesPlayedClassical: 5,
      ...overrides,
    });
  }

  function mockCourseProgress({ published = 30, completed = 0 }: { published?: number; completed?: number } = {}) {
    prisma.course.findUnique.mockResolvedValue({ id: 'course-beginner' });
    prisma.lesson.count.mockResolvedValue(published);
    prisma.userLessonProgress.count.mockResolvedValue(completed);
  }

  beforeEach(() => {
    prisma = {
      user: { findUniqueOrThrow: jest.fn() },
      course: { findUnique: jest.fn() },
      lesson: { count: jest.fn() },
      userLessonProgress: { count: jest.fn() },
    };
    service = new LevelGateService(prisma);
  });

  // В MVP gate всегда про beginner→intermediate; currentLevel фиксирован.

  it('все три условия выполнены → unlocked=true, blockers=[]', async () => {
    mockUser({ ratingPuzzle: 1250, gamesPlayedRapid: 10, gamesPlayedBlitz: 10, gamesPlayedClassical: 5 });
    mockCourseProgress({ published: 30, completed: 30 });

    const r = await service.getGate(userId);

    expect(r.currentLevel).toBe('beginner');
    expect(r.nextLevel).toBe('intermediate');
    expect(r.unlocked).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  it('курс не пройден → blocker course_not_completed с remaining', async () => {
    mockUser({ ratingPuzzle: 1250, gamesPlayedRapid: 20, gamesPlayedBlitz: 5, gamesPlayedClassical: 0 });
    mockCourseProgress({ published: 30, completed: 10 });

    const r = await service.getGate(userId);

    expect(r.unlocked).toBe(false);
    expect(r.blockers).toHaveLength(1);
    expect(r.blockers[0]).toEqual({ kind: 'course_not_completed', lessonsRemaining: 20 });
  });

  it('рейтинг ниже 1200, курс и партии ок → blocker puzzle_rating', async () => {
    mockUser({ ratingPuzzle: 1100, gamesPlayedRapid: 20, gamesPlayedBlitz: 0, gamesPlayedClassical: 0 });
    mockCourseProgress({ published: 5, completed: 5 });

    const r = await service.getGate(userId);

    expect(r.unlocked).toBe(false);
    expect(r.blockers).toEqual([
      { kind: 'puzzle_rating', required: 1200, current: 1100 },
    ]);
  });

  it('ровно на пороге рейтинга (1200) условие выполнено', async () => {
    mockUser({ ratingPuzzle: 1200, gamesPlayedRapid: 10, gamesPlayedBlitz: 10, gamesPlayedClassical: 5 });
    mockCourseProgress({ published: 1, completed: 1 });

    const r = await service.getGate(userId);
    expect(r.blockers.some((b) => b.kind === 'puzzle_rating')).toBe(false);
  });

  it('партий меньше 20, рейтинг и курс ок → blocker games_played', async () => {
    mockUser({ ratingPuzzle: 1300, gamesPlayedRapid: 5, gamesPlayedBlitz: 5, gamesPlayedClassical: 5 });
    mockCourseProgress({ published: 3, completed: 3 });

    const r = await service.getGate(userId);

    expect(r.unlocked).toBe(false);
    expect(r.blockers).toEqual([
      { kind: 'games_played', required: 20, current: 15 },
    ]);
  });

  it('ровно на пороге партий (20) условие выполнено', async () => {
    mockUser({ ratingPuzzle: 1300, gamesPlayedRapid: 10, gamesPlayedBlitz: 10, gamesPlayedClassical: 0 });
    mockCourseProgress({ published: 1, completed: 1 });

    const r = await service.getGate(userId);
    expect(r.blockers.some((b) => b.kind === 'games_played')).toBe(false);
  });

  it('все три блокера одновременно', async () => {
    mockUser({ ratingPuzzle: 900, gamesPlayedRapid: 1, gamesPlayedBlitz: 2, gamesPlayedClassical: 0 });
    mockCourseProgress({ published: 30, completed: 5 });

    const r = await service.getGate(userId);

    expect(r.unlocked).toBe(false);
    expect(r.blockers).toHaveLength(3);
    expect(r.blockers.map((b) => b.kind).sort()).toEqual([
      'course_not_completed',
      'games_played',
      'puzzle_rating',
    ]);
    const byKind = Object.fromEntries(r.blockers.map((b) => [b.kind, b]));
    expect(byKind.course_not_completed).toEqual({ kind: 'course_not_completed', lessonsRemaining: 25 });
    expect(byKind.puzzle_rating).toEqual({ kind: 'puzzle_rating', required: 1200, current: 900 });
    expect(byKind.games_played).toEqual({ kind: 'games_played', required: 20, current: 3 });
  });

  it('bullet не учитывается в games_played (только rapid+blitz+classical)', async () => {
    mockUser({
      ratingPuzzle: 1300,
      gamesPlayedRapid: 0,
      gamesPlayedBlitz: 0,
      gamesPlayedClassical: 0,
    });
    mockCourseProgress({ published: 1, completed: 1 });

    const r = await service.getGate(userId);

    // user может иметь много bullet-партий — они не учитываются.
    expect(r.blockers.find((b) => b.kind === 'games_played')).toEqual({
      kind: 'games_played',
      required: 20,
      current: 0,
    });
  });

  it('если курса «beginner» нет в БД — блокер course_not_completed с remaining=0', async () => {
    mockUser({ ratingPuzzle: 1300, gamesPlayedRapid: 10, gamesPlayedBlitz: 10, gamesPlayedClassical: 5 });
    prisma.course.findUnique.mockResolvedValue(null);

    const r = await service.getGate(userId);

    expect(r.unlocked).toBe(false);
    expect(r.blockers.some((b) => b.kind === 'course_not_completed' && b.lessonsRemaining === 0)).toBe(true);
  });

  it('курс с 0 опубликованных уроков — условие курса считается выполненным', async () => {
    mockUser({ ratingPuzzle: 1300, gamesPlayedRapid: 10, gamesPlayedBlitz: 10, gamesPlayedClassical: 5 });
    mockCourseProgress({ published: 0, completed: 0 });

    const r = await service.getGate(userId);
    expect(r.blockers.some((b) => b.kind === 'course_not_completed')).toBe(false);
  });
});
