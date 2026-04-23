import { Sm2Service } from './sm2.service';

describe('Sm2Service.applyReview (pure SM-2)', () => {
  const now = new Date('2026-04-23T03:00:00Z');
  const DAY = 24 * 60 * 60 * 1000;

  it('первый повтор (repetitions=0, q≥3) → interval=1', () => {
    const res = Sm2Service.applyReview(null, 5, now);
    expect(res.interval).toBe(1);
    expect(res.repetitions).toBe(1);
    expect(res.dueAt.getTime()).toBe(now.getTime() + 1 * DAY);
  });

  it('второй повтор (repetitions=1, q≥3) → interval=6', () => {
    const res = Sm2Service.applyReview(
      { easiness: 2.6, interval: 1, repetitions: 1 },
      5,
      now,
    );
    expect(res.interval).toBe(6);
    expect(res.repetitions).toBe(2);
    expect(res.dueAt.getTime()).toBe(now.getTime() + 6 * DAY);
  });

  it('последующие повторы: interval = round(interval * easiness)', () => {
    const res = Sm2Service.applyReview(
      { easiness: 2.5, interval: 6, repetitions: 2 },
      5,
      now,
    );
    // round(6 * 2.5) = 15
    expect(res.interval).toBe(15);
    expect(res.repetitions).toBe(3);
    expect(res.dueAt.getTime()).toBe(now.getTime() + 15 * DAY);
  });

  it('quality < 3 → сброс repetitions=0, interval=1', () => {
    const res = Sm2Service.applyReview(
      { easiness: 2.5, interval: 30, repetitions: 5 },
      2,
      now,
    );
    expect(res.repetitions).toBe(0);
    expect(res.interval).toBe(1);
    expect(res.dueAt.getTime()).toBe(now.getTime() + 1 * DAY);
  });

  it('easiness корректируется по формуле SM-2 (q=5 → +0.10)', () => {
    const res = Sm2Service.applyReview(
      { easiness: 2.5, interval: 1, repetitions: 0 },
      5,
      now,
    );
    // 2.5 + (0.1 - 0*0.08 - 0*0.02) = 2.6
    expect(res.easiness).toBeCloseTo(2.6);
  });

  it('easiness не может опуститься ниже 1.3', () => {
    const res = Sm2Service.applyReview(
      { easiness: 1.3, interval: 1, repetitions: 10 },
      0,
      now,
    );
    expect(res.easiness).toBe(Sm2Service.MIN_EASINESS);
  });

  it('q=3 даёт нейтральный EF (прирост ~ -0.14)', () => {
    const res = Sm2Service.applyReview(
      { easiness: 2.5, interval: 1, repetitions: 1 },
      3,
      now,
    );
    // 2.5 + (0.1 - 2*0.08 - 2*2*0.02) = 2.5 + (0.1 - 0.16 - 0.08) = 2.36
    expect(res.easiness).toBeCloseTo(2.36);
    expect(res.lastQuality).toBe(3);
  });
});

describe('Sm2Service.scoreToQuality', () => {
  it('0..49 → 0', () => {
    expect(Sm2Service.scoreToQuality(0)).toBe(0);
    expect(Sm2Service.scoreToQuality(49)).toBe(0);
  });
  it('50..59 → 2', () => {
    expect(Sm2Service.scoreToQuality(55)).toBe(2);
  });
  it('60..79 → 3', () => {
    expect(Sm2Service.scoreToQuality(60)).toBe(3);
    expect(Sm2Service.scoreToQuality(75)).toBe(3);
  });
  it('80..89 → 4', () => {
    expect(Sm2Service.scoreToQuality(80)).toBe(4);
    expect(Sm2Service.scoreToQuality(89)).toBe(4);
  });
  it('90..100 → 5', () => {
    expect(Sm2Service.scoreToQuality(95)).toBe(5);
    expect(Sm2Service.scoreToQuality(100)).toBe(5);
  });
});

describe('Sm2Service (БД-обёртки)', () => {
  let prisma: any;
  let service: Sm2Service;
  const userId = 'u1';
  const lessonId = 'L1';

  beforeEach(() => {
    prisma = {
      lessonReview: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      userLessonProgress: {
        updateMany: jest.fn(),
      },
    };
    service = new Sm2Service(prisma);
  });

  describe('scheduleReview', () => {
    it('создаёт новую запись, если её не было', async () => {
      prisma.lessonReview.findUnique.mockResolvedValue(null);
      prisma.lessonReview.create.mockResolvedValue({});

      const now = new Date('2026-04-23T03:00:00Z');
      const res = await service.scheduleReview(userId, lessonId, 5, now);

      expect(prisma.lessonReview.create).toHaveBeenCalledTimes(1);
      expect(prisma.lessonReview.update).not.toHaveBeenCalled();
      const args = prisma.lessonReview.create.mock.calls[0][0];
      expect(args.data.userId).toBe(userId);
      expect(args.data.lessonId).toBe(lessonId);
      expect(args.data.repetitions).toBe(1);
      expect(args.data.interval).toBe(1);
      expect(args.data.lastReviewedAt).toEqual(now);
      expect(args.data.lastQuality).toBe(5);
      expect(res.interval).toBe(1);
    });

    it('обновляет существующую запись', async () => {
      prisma.lessonReview.findUnique.mockResolvedValue({
        easiness: 2.6,
        interval: 1,
        repetitions: 1,
      });
      prisma.lessonReview.update.mockResolvedValue({});

      const now = new Date('2026-04-24T03:00:00Z');
      await service.scheduleReview(userId, lessonId, 5, now);

      expect(prisma.lessonReview.create).not.toHaveBeenCalled();
      const args = prisma.lessonReview.update.mock.calls[0][0];
      expect(args.data.interval).toBe(6);
      expect(args.data.repetitions).toBe(2);
    });
  });

  describe('getDueReviews', () => {
    it('возвращает только записи с dueAt <= date, порядок dueAt asc', async () => {
      const rows = [
        { lessonId: 'L1', dueAt: new Date('2026-04-22') },
        { lessonId: 'L2', dueAt: new Date('2026-04-23') },
      ];
      prisma.lessonReview.findMany.mockResolvedValue(rows);

      const res = await service.getDueReviews(userId, new Date('2026-04-23T12:00:00Z'));

      expect(prisma.lessonReview.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId, dueAt: { lte: new Date('2026-04-23T12:00:00Z') } },
          orderBy: { dueAt: 'asc' },
        }),
      );
      expect(res).toEqual(rows);
    });
  });

  describe('markLessonMastered — идемпотентность', () => {
    it('возвращает true при первом вызове (count=1)', async () => {
      prisma.userLessonProgress.updateMany.mockResolvedValue({ count: 1 });
      const res = await service.markLessonMastered(userId, lessonId);
      expect(res).toBe(true);
      const args = prisma.userLessonProgress.updateMany.mock.calls[0][0];
      expect(args.where).toEqual({ userId, lessonId, masteredAt: null });
    });

    it('возвращает false при повторном вызове (masteredAt уже установлен — count=0)', async () => {
      prisma.userLessonProgress.updateMany.mockResolvedValue({ count: 0 });
      const res = await service.markLessonMastered(userId, lessonId);
      expect(res).toBe(false);
    });
  });
});
