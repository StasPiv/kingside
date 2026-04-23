import { LevelGateController } from './level-gate.controller';
import { LevelGateService } from './level-gate.service';
import type { AuthenticatedRequest } from '../common/authenticated-request';

describe('LevelGateController', () => {
  let controller: LevelGateController;
  let service: jest.Mocked<LevelGateService>;

  const req = { user: { id: 'u1', username: 'u1' } } as unknown as AuthenticatedRequest;

  beforeEach(() => {
    service = { getGate: jest.fn() } as unknown as jest.Mocked<LevelGateService>;
    controller = new LevelGateController(service);
  });

  it('GET /lessons/level-gate → service.getGate(userId)', async () => {
    const payload = {
      currentLevel: 'beginner',
      nextLevel: 'intermediate',
      unlocked: false,
      blockers: [{ kind: 'puzzle_rating', required: 1200, current: 1100 }],
    } as const;
    service.getGate.mockResolvedValue(payload as any);

    const res = await controller.get(req);

    expect(service.getGate).toHaveBeenCalledWith('u1');
    expect(res).toBe(payload);
  });
});
