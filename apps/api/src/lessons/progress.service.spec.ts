import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProgressService } from './progress.service';

describe('ProgressService', () => {
  let service: ProgressService;
  let prisma: any;
  let sm2: {
    markLessonMastered: jest.Mock;
    scheduleReview: jest.Mock;
  };

  const userId = 'u1';
  const lessonId = 'L1';
  const stepId = 'S1';

  beforeEach(() => {
    prisma = {
      lesson: {
        findUnique: jest.fn(),
        count: jest.fn(),
      },
      lessonStep: {
        findUnique: jest.fn(),
      },
      userLessonProgress: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        count: jest.fn(),
      },
      userCourseProgress: {
        upsert: jest.fn(),
        update: jest.fn(),
      },
    };
    sm2 = {
      markLessonMastered: jest.fn().mockResolvedValue(true),
      scheduleReview: jest.fn().mockResolvedValue({
        easiness: 2.6,
        interval: 1,
        repetitions: 1,
        dueAt: new Date(),
      }),
    };
    service = new ProgressService(prisma, sm2 as any);
  });

  // ─── updateStep ──────────────────────────────────────────────────

  describe('updateStep', () => {
    it('404, если шаг не принадлежит уроку', async () => {
      prisma.lessonStep.findUnique.mockResolvedValue({ id: stepId, lessonId: 'other' });
      await expect(
        service.updateStep(userId, lessonId, stepId, 'done'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('upsert UserLessonProgress и мерджит stepsState', async () => {
      prisma.lessonStep.findUnique.mockResolvedValue({ id: stepId, lessonId });
      prisma.userLessonProgress.findUnique.mockResolvedValue({
        userId,
        lessonId,
        startedAt: new Date('2026-04-23T10:00:00Z'),
        completedAt: null,
        score: 0,
        stepsState: { 'S0': 'done' },
      });
      prisma.userLessonProgress.upsert.mockResolvedValue({
        userId,
        lessonId,
        startedAt: new Date('2026-04-23T10:00:00Z'),
        completedAt: null,
        score: 0,
        stepsState: { 'S0': 'done', 'S1': 'failed' },
      });
      // KS-2095: универсальный объект для всех вариантов select.
      prisma.lesson.findUnique.mockResolvedValue({
        id: lessonId,
        courseId: 'C1',
        parentLessonId: null,
        course: { parentCourseId: null },
      });
      prisma.userCourseProgress.upsert.mockResolvedValue({});
      prisma.lesson.count.mockResolvedValue(5);
      prisma.userLessonProgress.count.mockResolvedValue(1);

      const res = await service.updateStep(userId, lessonId, stepId, 'failed');

      expect(prisma.userLessonProgress.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_lessonId: { userId, lessonId } },
          update: { stepsState: { 'S0': 'done', 'S1': 'failed' } },
        }),
      );
      expect(res.stepsState).toEqual({ 'S0': 'done', 'S1': 'failed' });
      expect(res.score).toBe(0);
      // touchCourseProgress был вызван
      expect(prisma.userCourseProgress.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_courseId: { userId, courseId: 'C1' } },
          update: { currentLessonId: lessonId },
        }),
      );
    });

    it('score выдаёт в 0..1 (делит на 100)', async () => {
      prisma.lessonStep.findUnique.mockResolvedValue({ id: stepId, lessonId });
      prisma.userLessonProgress.findUnique.mockResolvedValue(null);
      prisma.userLessonProgress.upsert.mockResolvedValue({
        userId,
        lessonId,
        startedAt: new Date(),
        completedAt: null,
        score: 80,
        stepsState: { 'S1': 'done' },
      });
      // KS-2095: универсальный объект для всех вариантов select.
      prisma.lesson.findUnique.mockResolvedValue({
        id: lessonId,
        courseId: 'C1',
        parentLessonId: null,
        course: { parentCourseId: null },
      });
      prisma.userCourseProgress.upsert.mockResolvedValue({});
      prisma.lesson.count.mockResolvedValue(5);
      prisma.userLessonProgress.count.mockResolvedValue(0);

      const res = await service.updateStep(userId, lessonId, stepId, 'done');
      expect(res.score).toBeCloseTo(0.8);
    });
  });

  // ─── completeLesson ──────────────────────────────────────────────

  describe('completeLesson', () => {
    beforeEach(() => {
      prisma.lesson.findUnique.mockResolvedValue({
        id: lessonId,
        courseId: 'C1',
        parentLessonId: null,
        course: { parentCourseId: null },
      });
      prisma.userCourseProgress.upsert.mockResolvedValue({});
      prisma.lesson.count.mockResolvedValue(3);
      prisma.userLessonProgress.count.mockResolvedValue(0);
      sm2.scheduleReview.mockResolvedValue({
        easiness: 2.6,
        interval: 6,
        repetitions: 2,
        dueAt: new Date('2026-05-01T00:00:00Z'),
      });
    });

    it('400 при score вне [0, 1]', async () => {
      await expect(service.completeLesson(userId, lessonId, 1.5)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.completeLesson(userId, lessonId, -0.1)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('400 при quality вне [0, 5]', async () => {
      await expect(
        service.completeLesson(userId, lessonId, 0.9, 6),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.completeLesson(userId, lessonId, 0.9, -1),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404 если урок не найден', async () => {
      prisma.lesson.findUnique.mockResolvedValue(null);
      await expect(service.completeLesson(userId, lessonId, 0.9)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('400 при score < 0.7 (ниже порога «пройден»)', async () => {
      await expect(service.completeLesson(userId, lessonId, 0.5)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('upsert с completedAt при score ≥ 0.7 (конвертация в 0..100)', async () => {
      prisma.userLessonProgress.findUnique.mockResolvedValue(null);
      prisma.userLessonProgress.upsert.mockImplementation(async (args: any) => ({
        userId,
        lessonId,
        startedAt: new Date(),
        completedAt: new Date('2026-04-23T10:00:00Z'),
        score: 85,
        stepsState: {},
      }));

      const res = await service.completeLesson(userId, lessonId, 0.85);

      const upsertCall = prisma.userLessonProgress.upsert.mock.calls[0][0];
      expect(upsertCall.update.score).toBe(85);
      expect(upsertCall.update.completedAt).toBeInstanceOf(Date);
      expect(res.completedAt).toBe('2026-04-23T10:00:00.000Z');
      expect(res.score).toBeCloseTo(0.85);
    });

    it('ставит completedAt=null на UserCourseProgress пока не все уроки пройдены', async () => {
      prisma.userLessonProgress.findUnique.mockResolvedValue(null);
      prisma.userLessonProgress.upsert.mockResolvedValue({
        userId,
        lessonId,
        startedAt: new Date(),
        completedAt: new Date(),
        score: 80,
        stepsState: {},
      });
      prisma.lesson.count.mockResolvedValue(3);
      prisma.userLessonProgress.count.mockResolvedValue(2); // ещё не все

      await service.completeLesson(userId, lessonId, 0.8);
      expect(prisma.userCourseProgress.update).not.toHaveBeenCalled();
    });

    it('при score ≥ 0.8 → markLessonMastered + scheduleReview вызваны, ответ содержит SM-2 поля', async () => {
      prisma.userLessonProgress.findUnique.mockResolvedValue(null);
      prisma.userLessonProgress.upsert.mockResolvedValue({
        userId,
        lessonId,
        startedAt: new Date(),
        completedAt: new Date(),
        score: 85,
        stepsState: {},
      });

      const res = await service.completeLesson(userId, lessonId, 0.85);

      expect(sm2.markLessonMastered).toHaveBeenCalledWith(userId, lessonId);
      expect(sm2.scheduleReview).toHaveBeenCalledWith(userId, lessonId, 4); // score=85 → q=4
      expect(res.nextDueAt).toBe('2026-05-01T00:00:00.000Z');
      expect(res.intervalDays).toBe(6);
      expect(res.easeFactor).toBeCloseTo(2.6);
    });

    it('quality переданный клиентом используется вместо score→quality', async () => {
      prisma.userLessonProgress.findUnique.mockResolvedValue(null);
      prisma.userLessonProgress.upsert.mockResolvedValue({
        userId,
        lessonId,
        startedAt: new Date(),
        completedAt: new Date(),
        score: 85,
        stepsState: {},
      });

      await service.completeLesson(userId, lessonId, 0.85, 5);

      // score=85 маппился бы в q=4, но клиент передал 5 явно.
      expect(sm2.scheduleReview).toHaveBeenCalledWith(userId, lessonId, 5);
    });

    it('при 0.7 ≤ score < 0.8 — SM-2 не вызывается, SM-2 поля не возвращаются', async () => {
      prisma.userLessonProgress.findUnique.mockResolvedValue(null);
      prisma.userLessonProgress.upsert.mockResolvedValue({
        userId,
        lessonId,
        startedAt: new Date(),
        completedAt: new Date(),
        score: 75,
        stepsState: {},
      });

      const res = await service.completeLesson(userId, lessonId, 0.75);

      expect(sm2.markLessonMastered).not.toHaveBeenCalled();
      expect(sm2.scheduleReview).not.toHaveBeenCalled();
      expect(res.nextDueAt).toBeUndefined();
      expect(res.intervalDays).toBeUndefined();
      expect(res.easeFactor).toBeUndefined();
    });

    it('ставит UserCourseProgress.completedAt когда все опубликованные уроки пройдены', async () => {
      prisma.userLessonProgress.findUnique.mockResolvedValue(null);
      prisma.userLessonProgress.upsert.mockResolvedValue({
        userId,
        lessonId,
        startedAt: new Date(),
        completedAt: new Date(),
        score: 100,
        stepsState: {},
      });
      prisma.lesson.count.mockResolvedValue(3);
      prisma.userLessonProgress.count.mockResolvedValue(3);

      await service.completeLesson(userId, lessonId, 1.0);
      expect(prisma.userCourseProgress.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_courseId: { userId, courseId: 'C1' } },
          data: { completedAt: expect.any(Date) },
        }),
      );
    });
  });
});
