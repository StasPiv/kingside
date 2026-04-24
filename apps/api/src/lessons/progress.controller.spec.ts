import { ProgressController } from './progress.controller';
import { ProgressService } from './progress.service';
import { AdaptiveDifficultyService } from './adaptive-difficulty.service';
import type { AuthenticatedRequest } from '../common/authenticated-request';

describe('ProgressController', () => {
  let controller: ProgressController;
  let service: jest.Mocked<ProgressService>;
  let adaptive: jest.Mocked<AdaptiveDifficultyService>;

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
    controller = new ProgressController(service, adaptive);
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
});
