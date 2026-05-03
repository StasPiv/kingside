/**
 * KS-2247. `TacticDrillSfValidatorScheduler` юнит-тесты.
 */
import { TacticDrillSfValidatorScheduler } from './tactic-drill-sf-validator.scheduler';
import type { TacticDrillSfValidatorService } from './tactic-drill-sf-validator.service';

function makeValidator(): TacticDrillSfValidatorService {
  return {
    fetchUnvalidatedBatch: jest.fn().mockResolvedValue([]),
    validateOne: jest.fn().mockResolvedValue({ accepted: true }),
  } as unknown as TacticDrillSfValidatorService;
}

describe('TacticDrillSfValidatorScheduler — KS-2247', () => {
  let validator: TacticDrillSfValidatorService;
  let scheduler: TacticDrillSfValidatorScheduler;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    validator = makeValidator();
    scheduler = new TacticDrillSfValidatorScheduler(validator);
    // Throttle = 0 для быстрых тестов.
    process.env.TACTIC_DRILL_SF_THROTTLE_MS = '0';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('tick без ENV=1 → no-op', async () => {
    delete process.env.TACTIC_DRILL_SF_VALIDATOR_ENABLED;
    const spy = jest.spyOn(scheduler, 'runOnce');
    await scheduler.tick();
    expect(spy).not.toHaveBeenCalled();
  });

  it('runOnce: пустой batch → processed=0', async () => {
    (validator.fetchUnvalidatedBatch as jest.Mock).mockResolvedValue([]);
    const stats = await scheduler.runOnce();
    expect(stats).toEqual({ processed: 0, accepted: 0, rejected: 0, errors: 0 });
  });

  it('runOnce: считает accepted/rejected/errors корректно', async () => {
    (validator.fetchUnvalidatedBatch as jest.Mock).mockResolvedValue([
      { id: 'a', type: 'find-mate-in-one-square', fen: 'x', answer: {} },
      { id: 'b', type: 'find-mate-in-one-square', fen: 'x', answer: {} },
      { id: 'c', type: 'find-hanging-piece', fen: 'x', answer: {} },
    ]);
    (validator.validateOne as jest.Mock)
      .mockResolvedValueOnce({ accepted: true })
      .mockResolvedValueOnce({ accepted: false, reason: 'r1' })
      .mockRejectedValueOnce(new Error('boom'));

    const stats = await scheduler.runOnce();
    expect(stats).toEqual({
      processed: 3,
      accepted: 1,
      rejected: 1,
      errors: 1,
    });
  });

  it('runOnce: throttle между задачами (≥ throttleMs)', async () => {
    process.env.TACTIC_DRILL_SF_THROTTLE_MS = '50';
    (validator.fetchUnvalidatedBatch as jest.Mock).mockResolvedValue([
      { id: 'a', type: 'find-mate-in-one-square', fen: 'x', answer: {} },
      { id: 'b', type: 'find-mate-in-one-square', fen: 'x', answer: {} },
      { id: 'c', type: 'find-mate-in-one-square', fen: 'x', answer: {} },
    ]);
    const start = Date.now();
    await scheduler.runOnce();
    const elapsed = Date.now() - start;
    // Между 3 задачами 2 паузы по 50мс → ≥100мс.
    expect(elapsed).toBeGreaterThanOrEqual(95);
  });

  it('lock-защита: второй tick во время running → skip', async () => {
    process.env.TACTIC_DRILL_SF_VALIDATOR_ENABLED = '1';
    let resolveRun!: () => void;
    jest
      .spyOn(scheduler, 'runOnce')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRun = () =>
              resolve({ processed: 0, accepted: 0, rejected: 0, errors: 0 });
          }),
      );
    const t1 = scheduler.tick();
    const t2 = scheduler.tick();
    resolveRun();
    await Promise.all([t1, t2]);
    expect(scheduler.runOnce).toHaveBeenCalledTimes(1);
  });

  it('tick: ошибка runOnce ловится, не падает cron', async () => {
    process.env.TACTIC_DRILL_SF_VALIDATOR_ENABLED = '1';
    jest.spyOn(scheduler, 'runOnce').mockRejectedValue(new Error('db down'));
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });
});
