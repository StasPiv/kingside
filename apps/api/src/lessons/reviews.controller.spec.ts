import { LessonReviewsController } from './reviews.controller';
import type { AuthenticatedRequest } from '../common/authenticated-request';

describe('LessonReviewsController (KS-1809 / L-22)', () => {
  let controller: LessonReviewsController;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sm2: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;

  const req = {
    user: { id: 'u1', username: 'u1' },
  } as unknown as AuthenticatedRequest;

  beforeEach(() => {
    sm2 = { getDueReviews: jest.fn() };
    prisma = { lesson: { findMany: jest.fn() } };
    controller = new LessonReviewsController(sm2, prisma);
  });

  it('пустой список → { items: [] } без обращения к prisma', async () => {
    sm2.getDueReviews.mockResolvedValue([]);
    const res = await controller.getDueReviews(req);
    expect(res).toEqual({ items: [] });
    expect(prisma.lesson.findMany).not.toHaveBeenCalled();
  });

  it('маппит Sm2Service и Lesson в ReviewsDueResponse с нужными полями', async () => {
    const due = new Date('2026-04-24T08:00:00Z');
    const reviewed = new Date('2026-04-18T08:00:00Z');
    sm2.getDueReviews.mockResolvedValue([
      {
        lessonId: 'L1',
        dueAt: due,
        interval: 6,
        repetitions: 2,
        easiness: 2.5,
        lastReviewedAt: reviewed,
        lastQuality: 4,
      },
    ]);
    prisma.lesson.findMany.mockResolvedValue([
      {
        id: 'L1',
        slug: 'how-knight-moves',
        titleKey: 'lessons.beginner.how-knight-moves.title',
        course: { slug: 'beginner', titleKey: 'lessons.beginner.title' },
      },
    ]);

    const res = await controller.getDueReviews(req);

    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toEqual({
      courseSlug: 'beginner',
      courseTitleI18nKey: 'lessons.beginner.title',
      lessonSlug: 'how-knight-moves',
      lessonTitleI18nKey: 'lessons.beginner.how-knight-moves.title',
      dueAt: '2026-04-24T08:00:00.000Z',
      lastReviewedAt: '2026-04-18T08:00:00.000Z',
      intervalDays: 6,
    });
  });

  it('lastReviewedAt=null сохраняется как null (новый review)', async () => {
    sm2.getDueReviews.mockResolvedValue([
      {
        lessonId: 'L1',
        dueAt: new Date('2026-04-24T08:00:00Z'),
        interval: 1,
        repetitions: 0,
        easiness: 2.5,
        lastReviewedAt: null,
        lastQuality: null,
      },
    ]);
    prisma.lesson.findMany.mockResolvedValue([
      {
        id: 'L1',
        slug: 'l1',
        titleKey: 'l.title',
        course: { slug: 'c1', titleKey: 'c.title' },
      },
    ]);

    const res = await controller.getDueReviews(req);
    expect(res.items[0].lastReviewedAt).toBeNull();
    expect(res.items[0].intervalDays).toBe(1);
  });

  it('если lesson не найден в БД — запись отфильтровывается', async () => {
    sm2.getDueReviews.mockResolvedValue([
      {
        lessonId: 'missing',
        dueAt: new Date(),
        interval: 1,
        repetitions: 0,
        easiness: 2.5,
        lastReviewedAt: null,
        lastQuality: null,
      },
    ]);
    prisma.lesson.findMany.mockResolvedValue([]); // миссинг

    const res = await controller.getDueReviews(req);
    expect(res.items).toEqual([]);
  });
});
