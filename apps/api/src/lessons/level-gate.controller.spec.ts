import { BadRequestException } from '@nestjs/common';
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

  it('GET /lessons/level-gate без from → service.getGate(userId, undefined)', async () => {
    const payload = {
      currentLevel: 'beginner',
      nextLevel: 'intermediate',
      unlocked: false,
      blockers: [{ kind: 'puzzle_rating', required: 1200, current: 1100 }],
    } as const;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service.getGate.mockResolvedValue(payload as any);

    const res = await controller.get(req);

    expect(service.getGate).toHaveBeenCalledWith('u1', undefined);
    expect(res).toBe(payload);
  });

  it('GET /lessons/level-gate?from=intermediate → service.getGate(userId, "intermediate")', async () => {
    const payload = {
      currentLevel: 'intermediate',
      nextLevel: 'advanced',
      unlocked: false,
      blockers: [],
    } as const;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service.getGate.mockResolvedValue(payload as any);

    await controller.get(req, 'intermediate');

    expect(service.getGate).toHaveBeenCalledWith('u1', 'intermediate');
  });

  it('GET /lessons/level-gate?from=advanced → валидно, currentLevel=advanced', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service.getGate.mockResolvedValue({
      currentLevel: 'advanced',
      nextLevel: null,
      unlocked: true,
      blockers: [],
    } as any);

    await controller.get(req, 'advanced');
    expect(service.getGate).toHaveBeenCalledWith('u1', 'advanced');
  });

  it('GET /lessons/level-gate?from=garbage → 400 BadRequest', () => {
    expect(() => controller.get(req, 'garbage')).toThrow(BadRequestException);
    expect(service.getGate).not.toHaveBeenCalled();
  });
});
