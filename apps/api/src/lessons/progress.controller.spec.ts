import { ProgressController } from './progress.controller';
import { ProgressService } from './progress.service';
import type { AuthenticatedRequest } from '../common/authenticated-request';

describe('ProgressController', () => {
  let controller: ProgressController;
  let service: jest.Mocked<ProgressService>;

  const req = {
    user: { id: 'user-1', username: 'u1' },
  } as unknown as AuthenticatedRequest;

  beforeEach(() => {
    service = {
      updateStep: jest.fn(),
      completeLesson: jest.fn(),
    } as unknown as jest.Mocked<ProgressService>;
    controller = new ProgressController(service);
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

  it('POST /lessons/progress/lesson/complete → completeLesson(userId, lessonId, score)', async () => {
    service.completeLesson.mockResolvedValue({} as any);
    await controller.completeLesson(req, { lessonId: 'L1', score: 0.85 });
    expect(service.completeLesson).toHaveBeenCalledWith('user-1', 'L1', 0.85);
  });
});
