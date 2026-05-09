import { ProgressController } from './progress.controller';
import { ProgressService } from './progress.service';
import { AdaptiveDifficultyService } from './adaptive-difficulty.service';
import { UserProgressService } from './user-courses/user-progress.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedRequest } from '../common/authenticated-request';

describe('ProgressController', () => {
  let controller: ProgressController;
  let service: jest.Mocked<ProgressService>;
  let adaptive: jest.Mocked<AdaptiveDifficultyService>;
  let userProgressService: jest.Mocked<UserProgressService>;
  let prisma: { lesson: { findUnique: jest.Mock } };

  const req = {
    user: { id: 'user-1', username: 'u1' },
  } as unknown as AuthenticatedRequest;

  beforeEach(() => {
    service = {
      updateStep: jest.fn(),
      completeLesson: jest.fn(),
    } as unknown as jest.Mocked<ProgressService>;
    adaptive = {
      recordAttempt: jest.fn(),
    } as unknown as jest.Mocked<AdaptiveDifficultyService>;
    userProgressService = {
      updateStepProgress: jest.fn(),
      completeLesson: jest.fn(),
    } as unknown as jest.Mocked<UserProgressService>;
    prisma = { lesson: { findUnique: jest.fn() } };
    controller = new ProgressController(
      service,
      adaptive,
      userProgressService,
      prisma as unknown as PrismaService,
    );
  });

  it('POST /lessons/progress/step → updateStep(userId, lessonId, stepId, state)', async () => {
    service.updateStep.mockResolvedValue({} as any);
    await controller.updateStep(req, {
      lessonId: 'L1',
      stepId: 'S1',
      state: 'done',
    });
    expect(service.updateStep).toHaveBeenCalledWith('user-1', 'L1', 'S1', 'done');
  });

  it('POST /lessons/progress/lesson/complete → completeLesson(userId, lessonId, score) без quality', async () => {
    service.completeLesson.mockResolvedValue({} as any);
    await controller.completeLesson(req, { lessonId: 'L1', score: 0.85 });
    expect(service.completeLesson).toHaveBeenCalledWith('user-1', 'L1', 0.85, undefined);
  });

  it('POST /lessons/progress/lesson/complete прокидывает quality в сервис', async () => {
    service.completeLesson.mockResolvedValue({} as any);
    await controller.completeLesson(req, { lessonId: 'L1', score: 0.85, quality: 5 });
    expect(service.completeLesson).toHaveBeenCalledWith('user-1', 'L1', 0.85, 5);
  });

  it('POST /lessons/progress/puzzle-attempt → adaptive.recordAttempt(userId, lessonId, stepId, puzzleId, solved, timeSpent)', async () => {
    adaptive.recordAttempt.mockResolvedValue({} as any);

    await controller.puzzleAttempt(req, {
      lessonId: 'L1',
      stepId: 'S1',
      puzzleId: 'P1',
      solved: true,
      timeSpent: 4200,
    });

    expect(adaptive.recordAttempt).toHaveBeenCalledWith(
      'user-1',
      'L1',
      'S1',
      'P1',
      true,
      4200,
    );
  });

  it('POST /lessons/progress/puzzle-attempt без timeSpent — прокидывает undefined', async () => {
    adaptive.recordAttempt.mockResolvedValue({} as any);

    await controller.puzzleAttempt(req, {
      lessonId: 'L1',
      stepId: 'S1',
      puzzleId: 'P1',
      solved: false,
    });

    expect(adaptive.recordAttempt).toHaveBeenCalledWith(
      'user-1',
      'L1',
      'S1',
      'P1',
      false,
      undefined,
    );
  });

  // ─── KS-2646 / ADR-054 Phase D fix — унифицированная форма с :lessonId ─

  describe('POST /lessons/progress/lessons/:lessonId/step (unified)', () => {
    it('системный урок (ownerId=null) → ProgressService.updateStep', async () => {
      // KS-2655: после слияния `user_lessons` в `lessons` тип урока
      // определяется по `ownerId === null`, а не по presence в БД.
      prisma.lesson.findUnique.mockResolvedValue({ ownerId: null });
      service.updateStep.mockResolvedValue({} as any);
      await controller.unifiedUpdateStep(req, 'L1', {
        stepId: 'S1',
        state: 'done',
      });
      expect(service.updateStep).toHaveBeenCalledWith('user-1', 'L1', 'S1', 'done');
      expect(userProgressService.updateStepProgress).not.toHaveBeenCalled();
    });

    it('пользовательский урок (ownerId !== null) → UserProgressService.updateStepProgress', async () => {
      // KS-2655: пользовательский урок определяется ownerId, а не
      // отсутствием в `lessons`. До фикса findUnique возвращал
      // результат всегда → шли в системный сервис → completedAt не
      // выставлялся.
      prisma.lesson.findUnique.mockResolvedValue({ ownerId: 'owner-1' });
      userProgressService.updateStepProgress.mockResolvedValue({} as any);
      await controller.unifiedUpdateStep(req, 'UL1', {
        stepId: 'S1',
        state: 'failed',
      });
      expect(userProgressService.updateStepProgress).toHaveBeenCalledWith(
        'user-1',
        'UL1',
        'S1',
        'failed',
      );
      expect(service.updateStep).not.toHaveBeenCalled();
    });

    it('урок не найден → системный сервис (он кинет 404)', async () => {
      // KS-2655: если урок не существует, идём в системный сервис —
      // он отдаст единый 404 как и раньше.
      prisma.lesson.findUnique.mockResolvedValue(null);
      service.updateStep.mockRejectedValue(new Error('not found'));
      await expect(
        controller.unifiedUpdateStep(req, 'X', { stepId: 'S', state: 'done' }),
      ).rejects.toThrow('not found');
      expect(service.updateStep).toHaveBeenCalled();
    });
  });

  describe('POST /lessons/progress/lessons/:lessonId/complete (unified)', () => {
    it('системный урок (ownerId=null): прокидывает quality в ProgressService', async () => {
      prisma.lesson.findUnique.mockResolvedValue({ ownerId: null });
      service.completeLesson.mockResolvedValue({} as any);
      await controller.unifiedComplete(req, 'L1', { score: 0.9, quality: 4 });
      expect(service.completeLesson).toHaveBeenCalledWith('user-1', 'L1', 0.9, 4);
      expect(userProgressService.completeLesson).not.toHaveBeenCalled();
    });

    it('KS-2655 регрессия: пользовательский урок (ownerId !== null) → UserProgressService', async () => {
      // До фикса findUnique({id}) возвращал row для пользовательского
      // урока тоже — controller считал его системным и шёл в
      // ProgressService.completeLesson, у которого `touchCourseProgress`
      // фильтрует по `isPublished:true`. Пользовательские уроки по
      // CHECK constraint всегда `is_published=false` → completedAt
      // курса не выставлялся.
      prisma.lesson.findUnique.mockResolvedValue({ ownerId: 'owner-1' });
      userProgressService.completeLesson.mockResolvedValue({} as any);
      await controller.unifiedComplete(req, 'UL1', { score: 0.7, quality: 3 });
      // Для пользовательских уроков quality игнорируется (ADR-054 §3.2 п.7).
      expect(userProgressService.completeLesson).toHaveBeenCalledWith(
        'user-1',
        'UL1',
        0.7,
      );
      expect(service.completeLesson).not.toHaveBeenCalled();
    });
  });
});
