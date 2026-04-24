import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UserLessonsService } from './user-lessons.service';

describe('UserLessonsService (KS-1829)', () => {
  let service: UserLessonsService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      userLesson: {
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      userLessonStep: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      userLessonPlayProgress: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
      },
      userCoursePlayProgress: {
        upsert: jest.fn(),
      },
      $transaction: jest.fn((cb) =>
        cb({
          userLesson: prisma.userLesson,
          userLessonStep: prisma.userLessonStep,
        }),
      ),
    };
    service = new UserLessonsService(prisma);
  });

  // ─── getWithSteps ──────────────────────────────────────────────────

  describe('getWithSteps', () => {
    it('урок не найден → 404', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(null);
      await expect(service.getWithSteps('u1', 'l1')).rejects.toThrow(NotFoundException);
    });

    it('шаги сортируются по order (проверяем что prisma вызван с orderBy asc)', async () => {
      prisma.userLesson.findUnique.mockResolvedValue({
        id: 'l1',
        userCourseId: 'c1',
        order: 0,
        title: 't',
        estMinutes: null,
        _count: { steps: 2 },
        steps: [
          { id: 's1', userLessonId: 'l1', order: 0, type: 'text', payload: {} },
          { id: 's2', userLessonId: 'l1', order: 1, type: 'puzzle', payload: {} },
        ],
      });
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue(null);

      const r = await service.getWithSteps('u1', 'l1');
      expect(prisma.userLesson.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            steps: { orderBy: { order: 'asc' } },
          }),
        }),
      );
      expect(r.steps).toHaveLength(2);
    });
  });

  // ─── addStep ───────────────────────────────────────────────────────

  describe('addStep', () => {
    it('первый шаг получает order=0', async () => {
      prisma.userLessonStep.findFirst.mockResolvedValue(null);
      prisma.userLessonStep.create.mockImplementation(async ({ data }: any) => ({
        id: 's1',
        ...data,
      }));
      const r = await service.addStep('l1', {
        type: 'text',
        payload: { type: 'text', bodyMarkdown: '' } as any,
      });
      expect(prisma.userLessonStep.create.mock.calls[0][0].data.order).toBe(0);
      expect(r.order).toBe(0);
    });

    it('следующий шаг — max+1', async () => {
      prisma.userLessonStep.findFirst.mockResolvedValue({ order: 7 });
      prisma.userLessonStep.create.mockImplementation(async ({ data }: any) => ({
        id: 's1',
        ...data,
      }));
      const r = await service.addStep('l1', {
        type: 'puzzle',
        payload: {} as any,
      });
      expect(r.order).toBe(8);
    });

    it('пустой type → 400', async () => {
      await expect(
        service.addStep('l1', { payload: {} } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── reorderSteps ──────────────────────────────────────────────────

  describe('reorderSteps', () => {
    it('выставляет order по порядку id в массиве', async () => {
      prisma.userLessonStep.findMany.mockResolvedValue([
        { id: 'a' }, { id: 'b' }, { id: 'c' },
      ]);
      prisma.userLessonStep.update.mockResolvedValue({});

      await service.reorderSteps('l1', { ids: ['c', 'a', 'b'] });

      // Первая фаза: сдвиг в безопасный offset.
      // Вторая фаза: реальный order 0/1/2.
      const finalCalls = prisma.userLessonStep.update.mock.calls.slice(3);
      expect(finalCalls).toContainEqual([{ where: { id: 'c' }, data: { order: 0 } }]);
      expect(finalCalls).toContainEqual([{ where: { id: 'a' }, data: { order: 1 } }]);
      expect(finalCalls).toContainEqual([{ where: { id: 'b' }, data: { order: 2 } }]);
    });

    it('чужой id в списке → 400 (без апдейтов)', async () => {
      prisma.userLessonStep.findMany.mockResolvedValue([
        { id: 'a' }, { id: 'b' },
      ]);
      await expect(
        service.reorderSteps('l1', { ids: ['a', 'c'] }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.userLessonStep.update).not.toHaveBeenCalled();
    });

    it('неполный список (не все шаги) → 400', async () => {
      prisma.userLessonStep.findMany.mockResolvedValue([
        { id: 'a' }, { id: 'b' }, { id: 'c' },
      ]);
      await expect(
        service.reorderSteps('l1', { ids: ['a', 'b'] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('пустой ids → 400', async () => {
      await expect(
        service.reorderSteps('l1', { ids: [] }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── progress ──────────────────────────────────────────────────────

  describe('updateStepProgress', () => {
    it('создаёт прогресс при первом done', async () => {
      prisma.userLesson.findUnique.mockResolvedValue({
        id: 'l1',
        _count: { steps: 3 },
      });
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue(null);
      prisma.userLessonPlayProgress.create.mockImplementation(async ({ data }: any) => ({
        ...data,
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: null,
      }));

      const r = await service.updateStepProgress('u1', {
        userLessonId: 'l1',
        stepId: 's1',
        state: 'done',
      });
      expect(r.completedStepsCount).toBe(1);
      expect(r.totalSteps).toBe(3);
    });

    it('при done инкрементирует счётчик, но не выше totalSteps', async () => {
      prisma.userLesson.findUnique.mockResolvedValue({
        id: 'l1',
        _count: { steps: 2 },
      });
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        id: 'p1',
        completedStepsCount: 2,
        totalSteps: 2,
      });
      prisma.userLessonPlayProgress.update.mockImplementation(async ({ data }: any) => ({
        userLessonId: 'l1',
        completedStepsCount: data.completedStepsCount,
        totalSteps: data.totalSteps,
        startedAt: new Date(),
        lastActivityAt: data.lastActivityAt,
        completedAt: null,
      }));

      const r = await service.updateStepProgress('u1', {
        userLessonId: 'l1',
        stepId: 's1',
        state: 'done',
      });
      expect(r.completedStepsCount).toBe(2);
    });

    it('при failed/skipped НЕ инкрементирует счётчик', async () => {
      prisma.userLesson.findUnique.mockResolvedValue({
        id: 'l1',
        _count: { steps: 3 },
      });
      prisma.userLessonPlayProgress.findUnique.mockResolvedValue({
        id: 'p1',
        completedStepsCount: 1,
        totalSteps: 3,
      });
      prisma.userLessonPlayProgress.update.mockImplementation(async ({ data }: any) => ({
        userLessonId: 'l1',
        completedStepsCount: data.completedStepsCount,
        totalSteps: data.totalSteps,
        startedAt: new Date(),
        lastActivityAt: data.lastActivityAt,
        completedAt: null,
      }));

      const r = await service.updateStepProgress('u1', {
        userLessonId: 'l1',
        stepId: 's1',
        state: 'failed',
      });
      expect(r.completedStepsCount).toBe(1);
    });
  });

  describe('completeLesson', () => {
    it('выставляет completedAt и инкрементирует completedLessonsCount курса', async () => {
      prisma.userLesson.findUnique.mockResolvedValue({
        id: 'l1',
        _count: { steps: 4 },
        course: { id: 'c1' },
      });
      // upsert возвращает "новую" запись (completedAt == now).
      const now = new Date();
      prisma.userLessonPlayProgress.upsert.mockResolvedValue({
        userLessonId: 'l1',
        completedStepsCount: 4,
        totalSteps: 4,
        startedAt: now,
        lastActivityAt: now,
        completedAt: now,
      });

      const r = await service.completeLesson('u1', {
        userLessonId: 'l1',
        score: 1,
      });
      expect(r.completedAt).not.toBeNull();
      expect(prisma.userCoursePlayProgress.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_userCourseId: { userId: 'u1', userCourseId: 'c1' } },
        }),
      );
    });

    it('несуществующий урок → 404', async () => {
      prisma.userLesson.findUnique.mockResolvedValue(null);
      await expect(
        service.completeLesson('u1', { userLessonId: 'l1', score: 1 }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
