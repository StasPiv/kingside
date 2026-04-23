import { CoursesService } from './courses.service';

describe('CoursesService.recommendLevel (KS-1767 / ADR-024 §2.3)', () => {
  let service: CoursesService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn() },
      course: { findMany: jest.fn(), findUnique: jest.fn() },
      userCourseProgress: { findMany: jest.fn(), findUnique: jest.fn() },
      userLessonProgress: { findMany: jest.fn(), count: jest.fn() },
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
