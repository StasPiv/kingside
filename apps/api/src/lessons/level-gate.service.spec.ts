import { LevelGateService } from './level-gate.service';

describe('LevelGateService', () => {
  let service: LevelGateService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;

  const userId = 'u1';

  function mockUser(
    overrides: Partial<{
      ratingPuzzle: number;
      ratingRapid: number;
      gamesPlayedRapid: number;
      gamesPlayedBlitz: number;
      gamesPlayedClassical: number;
    }> = {},
  ) {
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      ratingPuzzle: 1500,
      ratingRapid: 1500,
      gamesPlayedRapid: 10,
      gamesPlayedBlitz: 10,
      gamesPlayedClassical: 5,
      ...overrides,
    });
  }

  /**
   * Настраивает прогресс по обоим курсам разом. Для сценариев, где нужен
   * отдельный контроль для beginner и intermediate, используем mock
   * `findUnique.mockImplementation`.
   */
  function mockCourseProgress({
    published = 30,
    completed = 0,
  }: { published?: number; completed?: number } = {}) {
    prisma.course.findUnique.mockResolvedValue({ id: 'course-x' });
    prisma.lesson.count.mockResolvedValue(published);
    prisma.userLessonProgress.count.mockResolvedValue(completed);
  }

  beforeEach(() => {
    prisma = {
      user: { findUniqueOrThrow: jest.fn() },
      course: { findUnique: jest.fn() },
      lesson: { count: jest.fn() },
      userLessonProgress: { count: jest.fn() },
      puzzleAttempt: { count: jest.fn().mockResolvedValue(0) },
    };
    service = new LevelGateService(prisma);
  });

  // ──────────────────────────────────────────────────────────────────
  // Beginner → Intermediate (KS-1770, существующий контракт)
  // ──────────────────────────────────────────────────────────────────

  describe('beginner → intermediate (L-15)', () => {
    it('все три условия выполнены → unlocked=true, blockers=[]', async () => {
      mockUser({
        ratingPuzzle: 1250,
        gamesPlayedRapid: 10,
        gamesPlayedBlitz: 10,
        gamesPlayedClassical: 5,
      });
      mockCourseProgress({ published: 30, completed: 30 });

      const r = await service.getGate(userId, 'beginner');

      expect(r.currentLevel).toBe('beginner');
      expect(r.nextLevel).toBe('intermediate');
      expect(r.unlocked).toBe(true);
      expect(r.blockers).toEqual([]);
    });

    it('курс не пройден → blocker course_not_completed с remaining', async () => {
      mockUser({
        ratingPuzzle: 1250,
        gamesPlayedRapid: 20,
        gamesPlayedBlitz: 5,
        gamesPlayedClassical: 0,
      });
      mockCourseProgress({ published: 30, completed: 10 });

      const r = await service.getGate(userId, 'beginner');

      expect(r.unlocked).toBe(false);
      expect(r.blockers).toHaveLength(1);
      expect(r.blockers[0]).toEqual({ kind: 'course_not_completed', lessonsRemaining: 20 });
    });

    it('рейтинг ниже 1200, курс и партии ок → blocker puzzle_rating', async () => {
      mockUser({
        ratingPuzzle: 1100,
        gamesPlayedRapid: 20,
        gamesPlayedBlitz: 0,
        gamesPlayedClassical: 0,
      });
      mockCourseProgress({ published: 5, completed: 5 });

      const r = await service.getGate(userId, 'beginner');

      expect(r.unlocked).toBe(false);
      expect(r.blockers).toEqual([{ kind: 'puzzle_rating', required: 1200, current: 1100 }]);
    });

    it('ровно на пороге рейтинга (1200) условие выполнено', async () => {
      mockUser({
        ratingPuzzle: 1200,
        gamesPlayedRapid: 10,
        gamesPlayedBlitz: 10,
        gamesPlayedClassical: 5,
      });
      mockCourseProgress({ published: 1, completed: 1 });

      const r = await service.getGate(userId, 'beginner');
      expect(r.blockers.some((b) => b.kind === 'puzzle_rating')).toBe(false);
    });

    it('1199 (на 1 ниже порога) → blocker puzzle_rating', async () => {
      mockUser({
        ratingPuzzle: 1199,
        gamesPlayedRapid: 10,
        gamesPlayedBlitz: 10,
        gamesPlayedClassical: 5,
      });
      mockCourseProgress({ published: 1, completed: 1 });

      const r = await service.getGate(userId, 'beginner');
      expect(r.blockers.some((b) => b.kind === 'puzzle_rating')).toBe(true);
    });

    it('партий меньше 20, рейтинг и курс ок → blocker games_played', async () => {
      mockUser({
        ratingPuzzle: 1300,
        gamesPlayedRapid: 5,
        gamesPlayedBlitz: 5,
        gamesPlayedClassical: 5,
      });
      mockCourseProgress({ published: 3, completed: 3 });

      const r = await service.getGate(userId, 'beginner');

      expect(r.unlocked).toBe(false);
      expect(r.blockers).toEqual([{ kind: 'games_played', required: 20, current: 15 }]);
    });

    it('ровно на пороге партий (20) условие выполнено', async () => {
      mockUser({
        ratingPuzzle: 1300,
        gamesPlayedRapid: 10,
        gamesPlayedBlitz: 10,
        gamesPlayedClassical: 0,
      });
      mockCourseProgress({ published: 1, completed: 1 });

      const r = await service.getGate(userId, 'beginner');
      expect(r.blockers.some((b) => b.kind === 'games_played')).toBe(false);
    });

    it('все три блокера одновременно', async () => {
      mockUser({
        ratingPuzzle: 900,
        gamesPlayedRapid: 1,
        gamesPlayedBlitz: 2,
        gamesPlayedClassical: 0,
      });
      mockCourseProgress({ published: 30, completed: 5 });

      const r = await service.getGate(userId, 'beginner');

      expect(r.unlocked).toBe(false);
      expect(r.blockers).toHaveLength(3);
      expect(r.blockers.map((b) => b.kind).sort()).toEqual([
        'course_not_completed',
        'games_played',
        'puzzle_rating',
      ]);
    });

    it('bullet не учитывается в games_played (только rapid+blitz+classical)', async () => {
      mockUser({
        ratingPuzzle: 1300,
        gamesPlayedRapid: 0,
        gamesPlayedBlitz: 0,
        gamesPlayedClassical: 0,
      });
      mockCourseProgress({ published: 1, completed: 1 });

      const r = await service.getGate(userId, 'beginner');

      expect(r.blockers.find((b) => b.kind === 'games_played')).toEqual({
        kind: 'games_played',
        required: 20,
        current: 0,
      });
    });

    it('если курса «beginner» нет в БД — блокер course_not_completed с remaining=0', async () => {
      mockUser({
        ratingPuzzle: 1300,
        gamesPlayedRapid: 10,
        gamesPlayedBlitz: 10,
        gamesPlayedClassical: 5,
      });
      prisma.course.findUnique.mockResolvedValue(null);

      const r = await service.getGate(userId, 'beginner');

      expect(r.unlocked).toBe(false);
      expect(
        r.blockers.some((b) => b.kind === 'course_not_completed' && b.lessonsRemaining === 0),
      ).toBe(true);
    });

    it('курс с 0 опубликованных уроков — условие курса считается выполненным', async () => {
      mockUser({
        ratingPuzzle: 1300,
        gamesPlayedRapid: 10,
        gamesPlayedBlitz: 10,
        gamesPlayedClassical: 5,
      });
      mockCourseProgress({ published: 0, completed: 0 });

      const r = await service.getGate(userId, 'beginner');
      expect(r.blockers.some((b) => b.kind === 'course_not_completed')).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Intermediate → Advanced (KS-1804 / L-26)
  // ──────────────────────────────────────────────────────────────────

  describe('intermediate → advanced (L-26)', () => {
    it('все четыре условия выполнены → unlocked=true, blockers=[]', async () => {
      mockUser({ ratingPuzzle: 1700, ratingRapid: 1400 });
      mockCourseProgress({ published: 20, completed: 20 });
      prisma.puzzleAttempt.count.mockResolvedValue(500);

      const r = await service.getGate(userId, 'intermediate');

      expect(r.currentLevel).toBe('intermediate');
      expect(r.nextLevel).toBe('advanced');
      expect(r.unlocked).toBe(true);
      expect(r.blockers).toEqual([]);
    });

    it('ratingPuzzle=1699 (на 1 ниже порога) → blocker puzzle_rating', async () => {
      mockUser({ ratingPuzzle: 1699, ratingRapid: 1400 });
      mockCourseProgress({ published: 1, completed: 1 });
      prisma.puzzleAttempt.count.mockResolvedValue(500);

      const r = await service.getGate(userId, 'intermediate');

      expect(r.unlocked).toBe(false);
      expect(r.blockers).toContainEqual({
        kind: 'puzzle_rating',
        required: 1700,
        current: 1699,
      });
    });

    it('ratingPuzzle=1700 ровно на пороге — условие выполнено', async () => {
      mockUser({ ratingPuzzle: 1700, ratingRapid: 1400 });
      mockCourseProgress({ published: 1, completed: 1 });
      prisma.puzzleAttempt.count.mockResolvedValue(500);

      const r = await service.getGate(userId, 'intermediate');
      expect(r.blockers.some((b) => b.kind === 'puzzle_rating')).toBe(false);
    });

    it('ratingRapid=1399 → blocker rapid_rating', async () => {
      mockUser({ ratingPuzzle: 1700, ratingRapid: 1399 });
      mockCourseProgress({ published: 1, completed: 1 });
      prisma.puzzleAttempt.count.mockResolvedValue(500);

      const r = await service.getGate(userId, 'intermediate');
      expect(r.blockers).toContainEqual({
        kind: 'rapid_rating',
        required: 1400,
        current: 1399,
      });
    });

    it('ratingRapid=1400 ровно на пороге — условие выполнено', async () => {
      mockUser({ ratingPuzzle: 1700, ratingRapid: 1400 });
      mockCourseProgress({ published: 1, completed: 1 });
      prisma.puzzleAttempt.count.mockResolvedValue(500);

      const r = await service.getGate(userId, 'intermediate');
      expect(r.blockers.some((b) => b.kind === 'rapid_rating')).toBe(false);
    });

    it('puzzlesSolved=499 → blocker puzzles_solved', async () => {
      mockUser({ ratingPuzzle: 1700, ratingRapid: 1400 });
      mockCourseProgress({ published: 1, completed: 1 });
      prisma.puzzleAttempt.count.mockResolvedValue(499);

      const r = await service.getGate(userId, 'intermediate');
      expect(r.blockers).toContainEqual({
        kind: 'puzzles_solved',
        required: 500,
        current: 499,
      });
    });

    it('puzzlesSolved=500 ровно на пороге — условие выполнено', async () => {
      mockUser({ ratingPuzzle: 1700, ratingRapid: 1400 });
      mockCourseProgress({ published: 1, completed: 1 });
      prisma.puzzleAttempt.count.mockResolvedValue(500);

      const r = await service.getGate(userId, 'intermediate');
      expect(r.blockers.some((b) => b.kind === 'puzzles_solved')).toBe(false);
    });

    it('курс intermediate не пройден → blocker course_not_completed', async () => {
      mockUser({ ratingPuzzle: 1800, ratingRapid: 1500 });
      mockCourseProgress({ published: 25, completed: 10 });
      prisma.puzzleAttempt.count.mockResolvedValue(600);

      const r = await service.getGate(userId, 'intermediate');
      expect(r.blockers).toContainEqual({
        kind: 'course_not_completed',
        lessonsRemaining: 15,
      });
    });

    it('все четыре блокера одновременно', async () => {
      mockUser({ ratingPuzzle: 1300, ratingRapid: 1100 });
      mockCourseProgress({ published: 20, completed: 3 });
      prisma.puzzleAttempt.count.mockResolvedValue(50);

      const r = await service.getGate(userId, 'intermediate');

      expect(r.unlocked).toBe(false);
      expect(r.blockers.map((b) => b.kind).sort()).toEqual([
        'course_not_completed',
        'puzzle_rating',
        'puzzles_solved',
        'rapid_rating',
      ]);
    });

    it('PuzzleAttempt.count вызывается с solved=true (не считает неверные)', async () => {
      mockUser({ ratingPuzzle: 1700, ratingRapid: 1400 });
      mockCourseProgress({ published: 1, completed: 1 });
      prisma.puzzleAttempt.count.mockResolvedValue(500);

      await service.getGate(userId, 'intermediate');

      expect(prisma.puzzleAttempt.count).toHaveBeenCalledWith({
        where: { userId, solved: true },
      });
    });

    it('bullet / blitz / classical рейтинги не влияют на rapid_rating gate', async () => {
      mockUser({
        ratingPuzzle: 1800,
        ratingRapid: 1399,
        gamesPlayedRapid: 1000,
        gamesPlayedBlitz: 1000,
        gamesPlayedClassical: 1000,
      });
      mockCourseProgress({ published: 1, completed: 1 });
      prisma.puzzleAttempt.count.mockResolvedValue(1000);

      const r = await service.getGate(userId, 'intermediate');
      expect(r.blockers.some((b) => b.kind === 'rapid_rating')).toBe(true);
      // games_played к gate intermediate→advanced не применяется
      expect(r.blockers.some((b) => b.kind === 'games_played')).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Advanced — терминальный уровень
  // ──────────────────────────────────────────────────────────────────

  describe('advanced (terminal)', () => {
    it('явный from=advanced → nextLevel=null, unlocked=true', async () => {
      mockUser({ ratingPuzzle: 2100, ratingRapid: 1800 });
      prisma.puzzleAttempt.count.mockResolvedValue(0);

      const r = await service.getGate(userId, 'advanced');

      expect(r.currentLevel).toBe('advanced');
      expect(r.nextLevel).toBeNull();
      expect(r.unlocked).toBe(true);
      expect(r.blockers).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Автовыбор currentLevel (без параметра from)
  // ──────────────────────────────────────────────────────────────────

  describe('resolveCurrentLevel (from не передан)', () => {
    it('beginner-gate не открыт → currentLevel=beginner', async () => {
      mockUser({
        ratingPuzzle: 1000,
        ratingRapid: 1000,
        gamesPlayedRapid: 0,
        gamesPlayedBlitz: 0,
        gamesPlayedClassical: 0,
      });
      mockCourseProgress({ published: 30, completed: 0 });
      prisma.puzzleAttempt.count.mockResolvedValue(0);

      const r = await service.getGate(userId);

      expect(r.currentLevel).toBe('beginner');
      expect(r.nextLevel).toBe('intermediate');
    });

    it('beginner закрыт, intermediate не открыт → currentLevel=intermediate', async () => {
      mockUser({
        ratingPuzzle: 1500, // выше 1200, ниже 1700
        ratingRapid: 1300,
        gamesPlayedRapid: 10,
        gamesPlayedBlitz: 10,
        gamesPlayedClassical: 0, // 20 — ровно порог
      });
      // оба курса — «пройдены» (прогресс = опубликовано)
      mockCourseProgress({ published: 5, completed: 5 });
      prisma.puzzleAttempt.count.mockResolvedValue(100);

      const r = await service.getGate(userId);

      expect(r.currentLevel).toBe('intermediate');
      expect(r.nextLevel).toBe('advanced');
      expect(r.unlocked).toBe(false);
      expect(r.blockers.some((b) => b.kind === 'puzzle_rating')).toBe(true);
    });

    it('оба gate закрыты → currentLevel=advanced, nextLevel=null', async () => {
      mockUser({
        ratingPuzzle: 1800,
        ratingRapid: 1500,
        gamesPlayedRapid: 50,
        gamesPlayedBlitz: 0,
        gamesPlayedClassical: 0,
      });
      mockCourseProgress({ published: 5, completed: 5 });
      prisma.puzzleAttempt.count.mockResolvedValue(600);

      const r = await service.getGate(userId);

      expect(r.currentLevel).toBe('advanced');
      expect(r.nextLevel).toBeNull();
      expect(r.unlocked).toBe(true);
    });
  });
});
