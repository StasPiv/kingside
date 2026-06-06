import { Test, TestingModule } from '@nestjs/testing';
import { LiveAnalysisCleanupScheduler } from './live-analysis-cleanup.scheduler';
import { LiveAnalysisService } from './live-analysis.service';

/**
 * KS-3733: smoke-тесты cron-scheduler'а cleanup-job'а. Реальный cron
 * не дёргаем — вызываем `tick()` напрямую и проверяем взаимодействие
 * со service (Redis-lock и закрытие — покрыты в service.spec).
 */
describe('LiveAnalysisCleanupScheduler', () => {
  let scheduler: LiveAnalysisCleanupScheduler;
  let service: {
    runCleanupTick: jest.Mock;
    resyncActiveGauge: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      runCleanupTick: jest.fn().mockResolvedValue({ locked: true, scanned: 0, closed: 0 }),
      resyncActiveGauge: jest.fn().mockResolvedValue(0),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LiveAnalysisCleanupScheduler,
        { provide: LiveAnalysisService, useValue: service as unknown as LiveAnalysisService },
      ],
    }).compile();
    scheduler = module.get(LiveAnalysisCleanupScheduler);
  });

  it('зовёт runCleanupTick и resyncActiveGauge раз за тик', async () => {
    await scheduler.tick();
    expect(service.runCleanupTick).toHaveBeenCalledTimes(1);
    expect(service.resyncActiveGauge).toHaveBeenCalledTimes(1);
  });

  it('не запускает повторно если предыдущий тик ещё работает', async () => {
    let resolveFirst: () => void;
    service.runCleanupTick.mockImplementationOnce(
      () => new Promise<{ locked: boolean; scanned: number; closed: number }>((resolve) => {
        resolveFirst = () => resolve({ locked: true, scanned: 0, closed: 0 });
      }),
    );
    const first = scheduler.tick();
    // Стартуем второй тик, пока первый висит.
    const second = scheduler.tick();
    await second;
    // runCleanupTick должен был вызваться 1 раз (второй тик — no-op).
    expect(service.runCleanupTick).toHaveBeenCalledTimes(1);
    resolveFirst!();
    await first;
  });

  it('не падает при ошибке тика', async () => {
    service.runCleanupTick.mockRejectedValueOnce(new Error('boom'));
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });
});
