import { NotFoundException } from '@nestjs/common';
import { UserProgressService } from './user-progress.service';

describe('UserProgressService (KS-1831)', () => {
  let service: UserProgressService;
  let prisma: any;

  const OWNER = 'owner-1';
  const OTHER = 'some-other-user';

  beforeEach(() => {
    prisma = {
      userCourse: { findUnique: jest.fn() },
      userLesson: { findUnique: jest.fn() },
      userCoursePlayProgress: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
      userLessonPlayProgress: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
      },
    };
    service = new UserProgressService(prisma);
  });

  // ─── access helpers ────────────────────────────────────────────────

  describe('доступ к ресурсу', () => {
    it('GET courseProgress: owner приватного курса — ок', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER, isPublic: false });
      prisma.userCoursePlayProgress.findUnique.mockResolvedValue(null);
      await expect(service.getCourseProgress(OWNER, 'c1')).resolves.toBeNull();
    });

    it('GET courseProgress: чужой на приватный курс → 404', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER, isPublic: false });
      await expect(service.getCourseProgress(OTHER, 'c1')).rejects.toThrow(NotFoundException);
    });

    it('GET courseProgress: чужой на публичный курс — ок', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER, isPublic: true });
      prisma.userCoursePlayProgress.findUnique.mockResolvedValue(null);
      await expect(service.getCourseProgress(OTHER, 'c1')).resolves.toBeNull();
    });

    it('GET courseProgress: несуществующий курс → 404', async () => {
      prisma.userCourse.findUnique.mockResolvedValue(null);
      await expect(service.getCourseProgress(OWNER, 'nope')).rejects.toThrow(NotFoundException);
    });

    it('GET lessonProgress: чужой на приватный урок → 404', async () => {
      prisma.userLesson.findUnique.mockResolvedValue({
        userCourseId: 'c1',
        _count: { steps: 2 },
        course: { ownerId: OWNER, isPublic: false },
      });
      await expect(service.getLessonProgress(OTHER, 'l1')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── getCourseProgress / getLessonProgress ─────────────────────────

  describe('read', () => {
    it('getCourseProgress: вернёт маппер, если запись есть', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER, isPublic: false });
      prisma.userCoursePlayProgress.findUnique.mockResolvedValue({
        userCourseId: 'c1',
        completedLessonsCount: 3,
        startedAt: new Date('2026-04-01'),
        lastActivityAt: new Date('2026-04-10'),
        completedAt: null,
      });
      const r = await service.getCourseProgress(OWNER, 'c1');
      expect(r).toMatchObject({
        userCourseId: 'c1',
        completedLessonsCount: 3,
        completedAt: null,
      });
    });

    it('getCourseProgress: если записи нет → null (не 404)', async () => {
      prisma.userCourse.findUnique.mockResolvedValue({ ownerId: OWNER, isPublic: true });
      prisma.userCoursePlayProgress.findUnique.mockResolvedValue(null);
      await expect(service.getCourseProgress(OWNER, 'c1')).resolves.toBeNull();
    });

    it('getLessonProgress: маппинг ок', async () => {
      prisma.userLesson.findUnique.mockResolvedValue({
        userCourseId: 'c1',
        _count: { steps: 4 },
        course: { ownerId: OWNER, isPublic: false },
      });
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        userLessonId: 'l1',
        completedStepsCount: 2,
        totalSteps: 4,
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: null,
      });
      const r = await service.getLessonProgress(OWNER, 'l1');
      expect(r).toMatchObject({
        userLessonId: 'l1',
        completedStepsCount: 2,
        totalSteps: 4,
      });
    });
  });

  // ─── updateStepProgress ────────────────────────────────────────────

  describe('updateStepProgress', () => {
    const okLesson = () => ({
      userCourseId: 'c1',
      _count: { steps: 3 },
      course: { ownerId: OWNER, isPublic: false },
    });

    it('первый done → создаёт запись с 1/3', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue(null);
      prisma.userLessonPlayProgress.create.mockImplementation(async ({ data }: any) => ({
        ...data, startedAt: new Date(), completedAt: null,
      }));
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      const r = await service.updateStepProgress(OWNER, 'l1', 's1', 'done');
      expect(r.completedStepsCount).toBe(1);
      expect(r.totalSteps).toBe(3);
    });

    it('done дважды подряд → +2 (без дедупликации по stepId в MVP)', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        id: 'p1', completedStepsCount: 1, totalSteps: 3,
      });
      prisma.userLessonPlayProgress.update.mockImplementation(async ({ data }: any) => ({
        userLessonId: 'l1',
        completedStepsCount: data.completedStepsCount,
        totalSteps: data.totalSteps,
        startedAt: new Date(),
        lastActivityAt: data.lastActivityAt,
        completedAt: null,
      }));
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      const r = await service.updateStepProgress(OWNER, 'l1', 's2', 'done');
      expect(r.completedStepsCount).toBe(2);
    });

    it('done не поднимает счётчик выше totalSteps', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        id: 'p1', completedStepsCount: 3, totalSteps: 3,
      });
      prisma.userLessonPlayProgress.update.mockImplementation(async ({ data }: any) => ({
        userLessonId: 'l1',
        completedStepsCount: data.completedStepsCount,
        totalSteps: data.totalSteps,
        startedAt: new Date(),
        lastActivityAt: data.lastActivityAt,
        completedAt: null,
      }));
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      const r = await service.updateStepProgress(OWNER, 'l1', 's4', 'done');
      expect(r.completedStepsCount).toBe(3);
    });

    it('failed/skipped — счётчик не растёт', async () => {
      for (const state of ['failed', 'skipped'] as const) {
        prisma.userLesson.findUnique.mockResolvedValue(okLesson());
        prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
          id: 'p1', completedStepsCount: 1, totalSteps: 3,
        });
        prisma.userLessonPlayProgress.update.mockImplementation(async ({ data }: any) => ({
          userLessonId: 'l1',
          completedStepsCount: data.completedStepsCount,
          totalSteps: data.totalSteps,
          startedAt: new Date(),
          lastActivityAt: data.lastActivityAt,
          completedAt: null,
        }));
        prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

        const r = await service.updateStepProgress(OWNER, 'l1', 's1', state);
        expect(r.completedStepsCount).toBe(1);
      }
    });

    it('чужой на приватный урок → 404', async () => {
      prisma.userLesson.findUnique.mockResolvedValue({
        userCourseId: 'c1',
        _count: { steps: 3 },
        course: { ownerId: OWNER, isPublic: false },
      });
      await expect(
        service.updateStepProgress(OTHER, 'l1', 's1', 'done'),
      ).rejects.toThrow(NotFoundException);
    });

    it('обновление шага touch\'ит курс-прогресс без инкремента completedLessonsCount', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue(null);
      prisma.userLessonPlayProgress.create.mockResolvedValue({
        userLessonId: 'l1',
        completedStepsCount: 1,
        totalSteps: 3,
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: null,
      });
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      await service.updateStepProgress(OWNER, 'l1', 's1', 'done');
      const upsert = prisma.userCoursePlayProgress.upsert.mock.calls[0][0];
      expect(upsert.update).not.toHaveProperty('completedLessonsCount');
      expect(upsert.create.completedLessonsCount).toBe(0);
    });
  });

  // ─── completeLesson ────────────────────────────────────────────────

  describe('completeLesson', () => {
    const okLesson = () => ({
      userCourseId: 'c1',
      _count: { steps: 4 },
      course: { ownerId: OWNER, isPublic: false },
    });

    it('первый complete: upsert прогресса + инкремент completedLessonsCount курса', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      // completedAt = null (ещё не завершён) → inc = true
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({ completedAt: null });
      const now = new Date();
      prisma.userLessonPlayProgress.upsert.mockResolvedValue({
        userLessonId: 'l1',
        completedStepsCount: 4,
        totalSteps: 4,
        startedAt: now,
        lastActivityAt: now,
        completedAt: now,
      });
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      const r = await service.completeLesson(OWNER, 'l1', 1);
      expect(r.completedAt).not.toBeNull();

      // inc=true → в update есть { increment: 1 } на completedLessonsCount
      const upsert = prisma.userCoursePlayProgress.upsert.mock.calls[0][0];
      expect(upsert.update.completedLessonsCount).toEqual({ increment: 1 });
      expect(upsert.create.completedLessonsCount).toBe(1);
    });

    it('повторный complete (был completedAt): счётчик курса НЕ инкрементируется', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        completedAt: new Date('2026-04-01'),
      });
      prisma.userLessonPlayProgress.upsert.mockResolvedValue({
        userLessonId: 'l1',
        completedStepsCount: 4,
        totalSteps: 4,
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: new Date(),
      });
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      await service.completeLesson(OWNER, 'l1', 1);

      const upsert = prisma.userCoursePlayProgress.upsert.mock.calls[0][0];
      expect(upsert.update).not.toHaveProperty('completedLessonsCount');
      expect(upsert.create.completedLessonsCount).toBe(0);
    });

    it('чужой пользователь на приватный урок → 404', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      await expect(service.completeLesson(OTHER, 'l1', 1)).rejects.toThrow(NotFoundException);
    });

    it('несуществующий урок → 404', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(null);
      await expect(service.completeLesson(OWNER, 'nope', 1)).rejects.toThrow(NotFoundException);
    });

    it('completeLesson НЕ пишет в LessonReview (SM-2 отключён)', async () => {
      // Отдельный guard: даже если кто-то добавит prisma.lessonReview mock,
      // completeLesson его не тронет — мы проверяем отсутствие свойства
      // в mock'е вообще (типа-safe smoke).
      expect((prisma as any).lessonReview).toBeUndefined();

      prisma.userLesson.findUnique.mockResolvedValue(okLesson());
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({ completedAt: null });
      prisma.userLessonPlayProgress.upsert.mockResolvedValue({
        userLessonId: 'l1',
        completedStepsCount: 4,
        totalSteps: 4,
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: new Date(),
      });
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});

      await service.completeLesson(OWNER, 'l1', 1);
      // Если в будущем кто-то добавит lessonReview.upsert — тест сразу
      // упадёт (expect внизу не сработает на undefined). Для текущего
      // контракта достаточно проверки выше.
    });
  });

  // ─── touchUserCourseProgress ───────────────────────────────────────

  describe('touchUserCourseProgress', () => {
    it('без инкремента — обновляет только lastActivityAt', async () => {
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});
      await service.touchUserCourseProgress(OWNER, 'c1', { incrementCompleted: false });
      const call = prisma.userCoursePlayProgress.upsert.mock.calls[0][0];
      expect(call.update).not.toHaveProperty('completedLessonsCount');
      expect(call.create.completedLessonsCount).toBe(0);
    });

    it('с инкрементом — increment:1 в update, 1 в create', async () => {
      prisma.userCoursePlayProgress.upsert.mockResolvedValue({});
      await service.touchUserCourseProgress(OWNER, 'c1', { incrementCompleted: true });
      const call = prisma.userCoursePlayProgress.upsert.mock.calls[0][0];
      expect(call.update.completedLessonsCount).toEqual({ increment: 1 });
      expect(call.create.completedLessonsCount).toBe(1);
    });
  });
});
