import { LessonsController } from './lessons.controller';
import { LessonsService } from './lessons.service';
import type { AuthenticatedRequest } from '../common/authenticated-request';

describe('LessonsController', () => {
  let controller: LessonsController;
  let service: jest.Mocked<LessonsService>;

  const req = {
    user: { id: 'user-1', username: 'u1' },
  } as unknown as AuthenticatedRequest;

  beforeEach(() => {
    service = {
      getLessonWithSteps: jest.fn(),
    } as unknown as jest.Mocked<LessonsService>;
    controller = new LessonsController(service);
  });

  it('GET /lessons/lessons/:id → service.getLessonWithSteps(id, userId)', async () => {
    const payload = { lesson: {} as any, steps: [], progress: null };
    service.getLessonWithSteps.mockResolvedValue(payload as any);
    const res = await controller.getOne(req, '00000000-0000-0000-0000-000000000001');
    expect(service.getLessonWithSteps).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      'user-1',
    );
    expect(res).toBe(payload);
  });
});
